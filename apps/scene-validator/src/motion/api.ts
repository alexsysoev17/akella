import {reviewForApproval,approveCodeRepair,sourcePromotionBusy} from "../harness/recovery/promotion.js";
import {verifyOriginalRun} from "../harness/recovery/replay.js";
import { harnessConfig } from "../harness/config.js";
import { recoveryPolicySchema } from "../harness/recovery/config.js";
import { recoveryMemory } from "../harness/recovery/memory.js";
import { renderProjectFrame, framePacket } from "../native/service.js";
import { nativePreviewHtml } from "../native/preview.js";
import { renderingMode, clearNativeCache } from "../native/client.js";
import {
  saveProviderSettings,
  loadProviderSettings,
  ProviderSettingsError,
} from "./provider-settings.js";
import {
  inspectorRuns,
  inspectorRun,
  debugReport,
  debugBundle,
  projectDiagnosticBundle,
} from "../harness/inspector.js";
import { candidates } from "../harness/improvements.js";
import { harnessMetrics } from "../harness/metrics.js";
import { readRuns } from "../harness/runtime.js";
import { experiences } from "../harness/experience.js";
import { providerIds, createProvider } from "../harness/providers/index.js";
import { applyOperations } from "./operations.js";
import { motionQA } from "./qa/render.js";
import { MotionFailure } from "./qa/technical.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { LoadedProject } from "../types.js";
import { atomicJson, safeDirectory, within, noSymlinkPath } from "../files.js";
import { readMotion, changeMotion } from "./store.js";
import { objectsIn } from "./context.js";
import {
  executeMotion,
  prepareMotionRequest,
  completeExecution,
  projectMotion,
  applyProposal,
  manualResponse,
} from "./service.js";
import { providerStatus } from "./provider.js";
import { motionHtml, sceneThumbnailHtml } from "./presentation.js";
import { exportVideo } from "./video.js";
const jobs = new Map<
  string,
  {
    projectId: string;
    status: "running" | "completed" | "failed";
    stage?: string;
    progress?: number;
    total?: number;
    result?: unknown;
    error?: string;
  }
>();
const active = new Set<string>();
const controllers = new Map<string, AbortController>();
export async function motionApi(
  project: LoadedProject,
  request: IncomingMessage,
  response: ServerResponse,
  segments: string[],
  body: (request: IncomingMessage, limit: number) => Promise<Buffer>,
) {
  if (segments[3] !== "motion") return false;
  const action = segments[4] ?? "";
  const json = (value: unknown, status = 200) => {
    response.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(value));
  };
  if (request.method === "GET") {
    if (action === "frame") {
      const query = new URL(request.url!, "http://127.0.0.1").searchParams;
      const frame = z.coerce
        .number()
        .int()
        .min(0)
        .max(108000)
        .parse(query.get("frame") ?? 0);
      const scale = z.coerce
        .number()
        .positive()
        .max(4)
        .parse(query.get("scale") ?? 1);
      const controller = new AbortController();
      response.on("close", () => controller.abort());
      const result = await renderProjectFrame(project, frame, {
        scale,
        encoding: query.get("transport") === "packet" ? "rgba" : "png",
        revision: query.get("revision") ?? undefined,
        signal: controller.signal,
      });
      const packet = query.get("transport") === "packet";
      response.writeHead(200, {
        "Content-Type": packet ? "application/x-akella-frame" : "image/png",
        "Cache-Control": "no-store",
        "X-Akella-Renderer": result.renderer,
        "X-Akella-Frame": String(result.frame),
        "X-Akella-Revision": result.revision,
      });
      response.end(packet ? framePacket(result) : result.png);
      return true;
    }

    if (!action) {
      const activeJob = (() => {
        for (const [id, job] of jobs) {
          if (
            job.projectId === project.config.projectId &&
            job.status === "running"
          ) {
            return {
              id,
              stage: job.stage,
              progress: job.progress,
              total: job.total,
            };
          }
        }
        return null;
      })();
      json({ ...(await projectMotion(project)), activeJob });
      return true;
    }
    if (action === "inspector") {
      const id = segments[5];
      if (!id) json(await inspectorRuns(project.root));
      else if (segments[6] === "bundle" || segments[6] === "project-bundle") {
        const bytes = await (
          segments[6] === "project-bundle"
            ? projectDiagnosticBundle
            : debugBundle
        )(project.root, id);
        response.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${segments[6] === "project-bundle" ? "project-diagnostic" : "agent"}-${z.uuid().parse(id)}.zip"`,
          "Cache-Control": "no-store",
        });
        response.end(bytes);
      } else if (segments[6] === "report") {
        response.writeHead(200, {
          "Content-Type": "text/markdown; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(debugReport(await inspectorRun(project.root, id)));
      } else
        json(
          await inspectorRun(
            project.root,
            id,
            new URL(request.url!, "http://127.0.0.1").searchParams.get(
              "raw",
            ) === "1",
          ),
        );
      return true;
    }
    if (action === "diagnostics") {
      const root = path.join(project.root, "motion/ai");
      let names: string[] = [];
      try {
        await noSymlinkPath(project.root, root);
        names = (await readdir(root)).filter(
          (n) => z.uuid().safeParse(n).success,
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const entries = await Promise.all(
        names.map(async (id) => {
          const dir = path.join(root, id);
          await noSymlinkPath(project.root, dir);
          return { id, time: (await stat(dir)).mtimeMs };
        }),
      );
      entries.sort((a, b) => b.time - a.time);
      const latest = entries[0];
      if (!latest) {
        json({
          status: "NOT_TESTED",
          harnessRuns: await readRuns(project.root),
        });
        return true;
      }
      const dir = path.join(root, latest.id),
        result: Record<string, unknown> = { id: latest.id };
      for (const name of [
        "intent-contract.json",
        "tasks.json",
        "execution.json",
        "request.json",
        "context.json",
        "proposal.json",
        "error.json",
        "attempt-1.json",
        "attempt-2.json",
        "attempt-3.json",
      ]) {
        const file = path.join(dir, name);
        try {
          await noSymlinkPath(project.root, file);
          const data = JSON.parse(await readFile(file, "utf8"));
          result[name] =
            name === "context.json"
              ? {
                  runtimeTarget: data.runtimeTarget,
                  mentions: data.mentions,
                  techniques: data.motionKnowledge?.techniques,
                }
              : data;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      }
      result.harnessRuns = (await readRuns(project.root))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, 20);
      result.providers = providerIds().map((id) => ({
        id,
        capabilities: createProvider(id, project.root).capabilities(),
      }));
      json(result);
      return true;
    }
    if (action === "recovery-settings") { json((await harnessConfig(project.root)).recovery); return true; }
    if (action === "recovery-memory") { json(await recoveryMemory(project.root)); return true; }
    if (action === "harness") {
      if (segments[5] === "improvements") {
        json(await candidates(project.root));
        return true;
      }
      if (segments[5] === "metrics") {
        json(harnessMetrics(await readRuns(project.root)));
        return true;
      }
      if (segments[5] === "experience") {
        json(await experiences(project.root));
        return true;
      }
      const runs = await readRuns(project.root);
      if (!segments[5]) {
        json(runs);
        return true;
      }
      const id = z.uuid().parse(segments[5]);
      const run = runs.find((r) => r.runId === id);
      if (!run) throw new Error("Harness Run not found");
      const file = within(project.root, `motion/harness/runs/${id}/trace.json`);
      await noSymlinkPath(project.root, file);
      json({ run, trace: JSON.parse(await readFile(file, "utf8")) });
      return true;
    }
    if (action === "qa") {
      const id = z.uuid().parse(segments[5]),
        attempt = segments[6],
        file = segments[7];
      if (
        !/^(attempt-[123]|task_[a-f0-9]{16}-attempt-[123]|manual)$/.test(
          attempt ?? "",
        ) ||
        !/^(report\.json|contact-sheet\.png|frame-\d+\.png)$/.test(file ?? "")
      )
        throw new Error("Invalid QA artifact");
      const target = within(project.root, `motion/qa/${id}/${attempt}/${file}`);
      await noSymlinkPath(project.root, target);
      response.writeHead(200, {
        "Content-Type": file.endsWith(".png")
          ? "image/png"
          : "application/json",
        "Cache-Control": "no-store",
      });
      response.end(await readFile(target));
      return true;
    }
    if (action === "provider") {
      json(
        await providerStatus(
          (await loadProviderSettings(project)).settings,
          project.root,
        ),
      );
      return true;
    }
    if (action === "object") {
      const sceneId = new URL(
        request.url!,
        "http://localhost",
      ).searchParams.get("sceneId");
      const targetId = decodeURIComponent(segments[5] ?? "");
      const s = project.inspection.document.scenes.find(
        (s) => s.sceneId === sceneId,
      );
      if (!s) throw new Error("Сцена не найдена");
      const object = objectsIn(s).find((o) => o.targetId === targetId);
      if (!object) throw new Error("Объект не найден");
      json(object);
      return true;
    }
    if (action === "jobs") {
      const job = jobs.get(segments[5]);
      if (!job || job.projectId !== project.config.projectId)
        throw new Error("Задание не найдено или сервер перезапущен");
      json(job);
      return true;
    }
    if (action === "thumbnail") {
      const sceneId = decodeURIComponent(segments[5] ?? "");
      const scene = project.inspection.document.scenes.find(
        (s) => s.sceneId === sceneId,
      );
      if (!scene) throw new Error("Scene not found");
      if (renderingMode() === "native") {
        const { defaultMotion } = await import("./context.js");
        const { renderNativeFrame } = await import("../native/client.js");
        const state = defaultMotion(project);
        state.blocks = [
          {
            ...state.blocks.find((b) => b.sceneId === sceneId)!,
            startFrame: 0,
          },
        ];
        state.settings.durationFrames = state.blocks[0].durationFrames;
        state.settings.width = Math.ceil(scene.width);
        state.settings.height = Math.ceil(scene.height);
        const result = await renderNativeFrame(project, state, 0, {
          scale: Math.min(1, 320 / scene.width),
        });
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
          "X-Akella-Renderer": result.renderer,
          "Content-Security-Policy":
            "default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'self'",
        });
        response.end(
          `<!doctype html><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}img{width:100%;height:100%;object-fit:contain}</style><img alt="" src="data:image/png;base64,${Buffer.from(result.png).toString("base64")}">`,
        );
        return true;
      }
      const html = await sceneThumbnailHtml(project, sceneId);
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        "Content-Security-Policy":
          "default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'self'",
      });
      response.end(html);
      return true;
    }
    if (action === "preview") {
      const doc = await readMotion(project);
      const native = renderingMode() === "native";
      const built = native
        ? {
            html: nativePreviewHtml(
              `/api/projects/${encodeURIComponent(project.config.projectId)}/motion`,
              doc.state.settings.width,
              doc.state.settings.height,
              doc.revision,
            ),
          }
        : await motionHtml(project, doc.state);
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; connect-src 'self'; img-src data: blob: 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'self'",
      });
      response.end(built.html);
      return true;
    }
    if (action === "renders") {
      if (!segments[5]) {
        let files: string[] = [];
        try {
          await noSymlinkPath(project.root, path.join(project.root, "renders"));
          files = (await readdir(path.join(project.root, "renders")))
            .filter((n) => /^motion-[a-f0-9-]+\.mp4$/.test(n))
            .sort()
            .reverse();
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        json({ files });
        return true;
      }
      const name = segments[5];
      if (!/^motion-[a-f0-9-]+\.mp4$/.test(name))
        throw new Error("Некорректное имя видео");
      const file = within(project.root, `renders/${name}`);
      await noSymlinkPath(project.root, file);
      const size = (await stat(file)).size;
      const range = request.headers.range;
      let start = 0,
        end = size - 1;
      if (range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (!match) throw new Error("Некорректный Range");
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : end;
        if (start > end || end >= size) throw new Error("Range вне файла");
      }
      response.writeHead(range ? 206 : 200, {
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
      });
      createReadStream(file, { start, end }).pipe(response);
      return true;
    }
  }
  if (request.method === "POST") {
    if(sourcePromotionBusy && action!=="cancel")throw Error("Идёт применение проверенного исправления кода");
    if(action==="code-repair-review"||action==="code-repair-approve"){
      if(!request.headers["content-type"]?.startsWith("application/json"))throw Error("application/json required");
      const value=z.object({runId:z.uuid(),patchIdentity:z.string().regex(/^[a-f0-9]{64}$/),approvalToken:z.string().optional()}).strict().parse(JSON.parse((await body(request,4000)).toString()));
      const file=path.join(project.root,"motion/ai",value.runId,"code-repair.json");await noSymlinkPath(project.root,file);
      const proposal=JSON.parse(await readFile(file,"utf8"));
      if(proposal.patchIdentity!==value.patchIdentity||proposal.status!=="AWAITING_APPROVAL")throw Error("PATCH_NOT_REVIEWABLE");
      const repository=process.cwd();
      if(action==="code-repair-review"){json(await reviewForApproval(repository,proposal.workspace,value.patchIdentity));return true;}
      if([...jobs.values()].some(j=>j.status==="running"))throw Error("Дождитесь завершения текущих заданий");
      const id=randomUUID();jobs.set(id,{projectId:project.config.projectId,status:"running",stage:"source-repair-verification"});json({jobId:id},202);
      void approveCodeRepair(repository,proposal.workspace,value.patchIdentity,value.approvalToken??"",isolated=>verifyOriginalRun(isolated,project.root,value.runId,repository)).then(async result=>{
        await atomicJson(file,{...proposal,...result});jobs.set(id,{projectId:project.config.projectId,status:"completed",result});
      }).catch(error=>jobs.set(id,{projectId:project.config.projectId,status:"failed",error:String(error)}));
      return true;
    }
    if (action === "recovery-settings") {
      const policy=recoveryPolicySchema.parse(JSON.parse((await body(request,20000)).toString()));
      const existing=await harnessConfig(project.root);
      await safeDirectory(project.root,"motion/harness");
      await atomicJson(path.join(project.root,"motion/harness/config.json"),{...existing,recovery:policy});
      json(policy);return true;
    }
    if (action === "render-cache-clear") {
      await clearNativeCache();
      json({ cleared: true });
      return true;
    }
    if (action === "render-sequence") {
      const value = z
        .object({
          frames: z.array(z.number().int().min(0).max(108000)).min(1).max(30),
          revision: z.string().optional(),
        })
        .strict()
        .parse(JSON.parse((await body(request, 20000)).toString()));
      const id = randomUUID(),
        controller = new AbortController(),
        job = {
          projectId: project.config.projectId,
          status: "running" as "running" | "completed" | "failed",
          stage: "native-render",
          progress: 0,
          total: value.frames.length,
          result: undefined as unknown,
          error: undefined as string | undefined,
        };
      if (jobs.size > 200) {
        for (const [key, v] of jobs)
          if (v.status !== "running") {
            jobs.delete(key);
            break;
          }
      }
      jobs.set(id, job);
      controllers.set(id, controller);
      json({ jobId: id }, 202);
      void (async () => {
        try {
          for (const frame of value.frames) {
            await renderProjectFrame(project, frame, {
              revision: value.revision,
              encoding: "rgba",
              signal: controller.signal,
            });
            job.progress++;
          }
          job.status = "completed";
          job.result = { frames: value.frames, renderer: "skia-cpu/1" };
        } catch (e) {
          job.status = "failed";
          job.error = String(e);
        } finally {
          controllers.delete(id);
        }
      })();
      return true;
    }

    if (!request.headers["content-type"]?.startsWith("application/json"))
      throw new Error("application/json required");
    const input: unknown = JSON.parse(
      (await body(request, 1024 * 1024)).toString(),
    );
    if (action === "provider-settings") {
      try {
        json(await saveProviderSettings(project, input, "api-settings"));
      } catch (error) {
        if (!(error instanceof ProviderSettingsError)) throw error;
        json({ error: error.message, errorCode: error.code }, 400);
      }
      return true;
    }
    if (action === "cancel") {
      const { jobId } = z.object({ jobId: z.uuid() }).strict().parse(input);
      const job = jobs.get(jobId);
      if (!job || job.projectId !== project.config.projectId)
        throw new Error("Unknown project job");
      controllers.get(jobId)?.abort(new Error("CANCELLED"));
      json({ status: "CANCELLATION_REQUESTED" });
      return true;
    }
    if (action === "operations") {
      const data = z
        .object({
          expectedRevision: z.string(),
          operations: z.unknown(),
          request: z.string().max(20000),
        })
        .strict()
        .parse(input);
      const current = await readMotion(project);
      if (current.revision !== data.expectedRevision)
        throw new Error("Анимация изменилась; запрос устарел");
      const candidate = applyOperations(
        current.state,
        data.operations,
        project,
      );
      const qa = await motionQA(
        project,
        candidate,
        `motion/qa/${randomUUID()}/manual`,
        data.request,
        current.state,
      );
      if (qa.status === "FAILED") throw new MotionFailure(qa);
      json(await changeMotion(project.root, data));
      return true;
    }
    if (action === "undo" || action === "redo") {
      const data = z
        .object({ expectedRevision: z.string() })
        .strict()
        .parse(input);
      json(
        await changeMotion(project.root, { ...data, action, request: action }),
      );
      return true;
    }
    if (action === "apply") {
      const data = z.object({ proposalId: z.uuid() }).strict().parse(input);
      json(await applyProposal(project, data.proposalId));
      return true;
    }
    if (action === "manual-response") {
      const data = z
        .object({ proposalId: z.uuid(), response: z.unknown() })
        .strict()
        .parse(input);
      await manualResponse(project, data.proposalId, data.response);
      json(await completeExecution(project, data.proposalId));
      return true;
    }
    if (action === "execute" || action === "plan" || action === "render") {
      if (action !== "render")
        try {
          await prepareMotionRequest(project, input);
        } catch (error) {
          if (!(error instanceof ProviderSettingsError)) throw error;
          json({ error: error.message, errorCode: error.code }, 400);
          return true;
        }
      const key =
        project.config.projectId +
        ":" +
        (action === "plan" ? "execute" : action);
      if (active.has(key)) throw new Error("Это задание уже выполняется");
      active.add(key);
      const id = randomUUID();
      const controller = new AbortController();
      controllers.set(id, controller);
      jobs.set(id, { projectId: project.config.projectId, status: "running" });
      const work =
        action !== "render"
          ? () =>
              executeMotion(
                project,
                input,
                (stage) =>
                  jobs.set(id, {
                    projectId: project.config.projectId,
                    status: "running",
                    stage,
                  }),
                { signal: controller.signal },
              )
          : () =>
              exportVideo(
                project.root,
                (progress, total) =>
                  jobs.set(id, {
                    projectId: project.config.projectId,
                    status: "running",
                    progress,
                    total,
                  }),
                { signal: controller.signal },
              );
      void work()
        .then((result) =>
          jobs.set(id, {
            projectId: project.config.projectId,
            status: "completed",
            result,
          }),
        )
        .catch((e) =>
          jobs.set(id, {
            projectId: project.config.projectId,
            status: "failed",
            error: e instanceof ProviderSettingsError ? e.message : String(e),
          }),
        )
        .finally(() => {
          active.delete(key);
          controllers.delete(id);
          if (jobs.size > 100)
            for (const [old, job] of jobs) {
              if (job.status !== "running") {
                jobs.delete(old);
                break;
              }
            }
        });
      json({ jobId: id }, 202);
      return true;
    }
  }
  json({ error: "Маршрут Motion не найден" }, 404);
  return true;
}
