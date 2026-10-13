import { recoverInterruptedRuns } from "./harness/runtime.js";
import { motionApi } from "./motion/api.js";
import { diagnosticRu } from "./localization.js";
import { createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  rename,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProject, extractZip } from "./importer.js";
import { inspectSource } from "./source.js";
import {
  discoverProjects,
  findProject,
  readOptional,
  summary,
} from "./management.js";
import { noSymlinkPath, within, lockProject } from "./files.js";
import { validateProject } from "./validation.js";

async function body(request: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("Upload exceeds size limit");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export async function servePlatform(projectsRoot: string, port = 4173) {
  projectsRoot = path.resolve(projectsRoot);
  await mkdir(projectsRoot, { recursive: true });
  await noSymlinkPath(projectsRoot, projectsRoot);
  for (const project of (await discoverProjects(projectsRoot)).projects)
    await recoverInterruptedRuns(project.root);
  const pending = new Map<
    string,
    {
      folder: string;
      source: string;
      name: string;
      projectId?: string;
      fingerprint?: string;
      expires: number;
    }
  >();
  const jobs = new Map<string, { status: string; error?: string }>();
  const active = new Set<string>();
  const server = createServer(async (request, response) => {
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(value));
    };
    try {
      const host = request.headers.host;
      if (
        host !== `127.0.0.1:${(server.address() as { port: number }).port}` &&
        host !== `localhost:${(server.address() as { port: number }).port}`
      )
        throw new Error("Invalid Host");
      const origin = request.headers.origin;
      if (origin && origin !== `http://${host}`)
        throw new Error("Foreign origin forbidden");
      const url = new URL(request.url ?? "/", `http://${host}`);
      const segments = url.pathname.split("/").filter(Boolean);
      const sendFile = async (file: string, mime: string) => {
        const bytes = await readFile(file);
        response.writeHead(200, {
          "Content-Type": mime,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy":
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-src 'self'; base-uri 'none'; frame-ancestors 'self'",
        });
        response.end(bytes);
      };
      if (
        request.method === "GET" &&
        [
          "/",
          "/main.js",
          "/styles.css",
          "/motion.js",
          "/inspector.js",
          "/motion.css",
          "/easing-runtime.js",
          "/mentions.js",
          "/provider-contract.js",
        ].includes(url.pathname)
      ) {
        const name =
          url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        return await sendFile(
          fileURLToPath(new URL(`./web/${name}`, import.meta.url)),
          name.endsWith(".js")
            ? "text/javascript"
            : name.endsWith(".css")
              ? "text/css"
              : "text/html",
        );
      }
      if (request.method === "GET" && url.pathname === "/api/projects") {
        const result = await discoverProjects(projectsRoot);
        return json({
          projects: result.projects.map(summary),
          errors: result.errors,
        });
      }
      if (
        request.method === "GET" &&
        segments[0] === "api" &&
        segments[1] === "jobs"
      )
        return json(jobs.get(segments[2]) ?? { status: "unknown" });
      if (request.method === "POST" && url.pathname === "/api/import-preview") {
        if (!request.headers["content-type"]?.startsWith("application/zip"))
          throw new Error("application/zip required");
        if (pending.size >= 4)
          throw new Error(
            "Finish or wait for pending imports before uploading more",
          );
        const name = url.searchParams.get("name")?.trim();
        if (!name || name.length > 200)
          throw new Error("Project name required (max 200 characters)");
        const id = url.searchParams.get("projectId") ?? undefined;
        const current = id ? await findProject(projectsRoot, id) : undefined;
        const folder = await mkdtemp(path.join(projectsRoot, ".upload-"));
        try {
          const zip = path.join(folder, "input.zip");
          let size = 0;
          await pipeline(
            request,
            new Transform({
              transform(chunk, _encoding, callback) {
                size += chunk.length;
                callback(
                  size > 512 * 1024 * 1024
                    ? new Error("ZIP exceeds 512 MiB")
                    : null,
                  chunk,
                );
              },
            }),
            createWriteStream(zip, { flags: "wx" }),
          );
          const source = await extractZip(zip, path.join(folder, "export"));
          const inspection = await inspectSource(source);
          const token = randomUUID();
          pending.set(token, {
            folder,
            source,
            name: current?.config.name ?? name,
            projectId: id,
            fingerprint: current?.inspection.fingerprint,
            expires: Date.now() + 600000,
          });
          const before = current?.inspection.document.scenes ?? [];
          const after = inspection.document.scenes;
          return json({
            token,
            sceneCount: after.length,
            assetCount: inspection.document.assets.length,
            warnings: inspection.warnings.map(diagnosticRu),
            changes: current
              ? {
                  previousScenes: before.length,
                  newScenes: after.length,
                  added: after
                    .filter((s) => !before.some((b) => b.sceneId === s.sceneId))
                    .map((s) => s.name),
                  removed: before
                    .filter((s) => !after.some((b) => b.sceneId === s.sceneId))
                    .map((s) => s.name),
                  changed: after
                    .filter((s) => {
                      const b = before.find((b) => b.sceneId === s.sceneId);
                      return b && JSON.stringify(b) !== JSON.stringify(s);
                    })
                    .map((s) => s.name),
                  sourceChanged:
                    current.inspection.fingerprint !== inspection.fingerprint,
                }
              : null,
          });
        } catch (error) {
          await rm(folder, { recursive: true, force: true });
          throw error;
        }
      }
      if (request.method === "POST" && url.pathname === "/api/import-commit") {
        if (!request.headers["content-type"]?.startsWith("application/json"))
          throw new Error("application/json required");
        const { token } = JSON.parse(
          (await body(request, 4096)).toString(),
        ) as { token: string };
        const item = pending.get(token);
        if (!item || item.expires < Date.now())
          throw new Error("Import preview expired; upload again");
        pending.delete(token);
        try {
          const current = item.projectId
            ? await findProject(projectsRoot, item.projectId)
            : undefined;
          const result = await createProject({
            name: item.name,
            source: item.source,
            projectsRoot,
            update: !!current,
            projectPath: current?.root,
            expectedFingerprint: item.fingerprint,
          });
          return json(
            {
              projectId: result.config.projectId,
              updated: result.updated,
              warnings: result.inspection.warnings,
            },
            201,
          );
        } finally {
          await rm(item.folder, { recursive: true, force: true });
        }
      }
      if (segments[0] === "api" && segments[1] === "projects" && segments[2]) {
        const project = await findProject(projectsRoot, segments[2]);
        if (await motionApi(project, request, response, segments, body)) return;
        if (request.method === "GET" && segments.length === 3) {
          const report = await readOptional(
            project.root,
            "validation/report.json",
          );
          return json({
            ...summary(project),
            scenes: project.inspection.document.scenes.map((s) => ({
              ...s,
              objects: countNodes(s.children),
            })),
            warnings: project.inspection.warnings,
            notes: {
              brief: (await readOptional(project.root, "notes/brief.md")) ?? "",
              scenes:
                (await readOptional(project.root, "notes/scenes.md")) ?? "",
            },
            report: report ? JSON.parse(report) : null,
            imports: project.config.imports,
          });
        }
        if (request.method === "POST" && segments[3] === "validate") {
          if (!request.headers["content-type"]?.startsWith("application/json"))
            throw new Error("application/json required");
          if (active.has(project.config.projectId))
            throw new Error("Validation already running");
          const id = randomUUID();
          active.add(project.config.projectId);
          jobs.set(id, { status: "running" });
          void validateProject(project.root, { reconstruct: true })
            .then((report) =>
              jobs.set(id, {
                status: report.status === "passed" ? "completed" : "failed",
                error: report.errors.map(diagnosticRu).join("\n"),
              }),
            )
            .catch((error) =>
              jobs.set(id, {
                status: "failed",
                error: diagnosticRu(String(error)),
              }),
            )
            .finally(() => active.delete(project.config.projectId));
          return json({ jobId: id }, 202);
        }
        if (request.method === "PUT" && segments[3] === "notes") {
          if (!request.headers["content-type"]?.startsWith("application/json"))
            throw new Error("application/json required");
          const note = JSON.parse(
            (await body(request, 1024 * 1024)).toString(),
          ) as { brief: unknown; scenes: unknown };
          if (typeof note.brief !== "string" || typeof note.scenes !== "string")
            throw new Error("Notes must be text");
          const unlock = await lockProject(project.root);
          try {
            for (const [name, text] of [
              ["brief", note.brief],
              ["scenes", note.scenes],
            ]) {
              const target = within(project.root, `notes/${name}.md`);
              await noSymlinkPath(project.root, target);
              const temporary = within(
                project.root,
                `notes/.${randomUUID()}.tmp`,
              );
              try {
                await writeFile(temporary, text, { flag: "wx" });
                await rename(temporary, target);
              } finally {
                await rm(temporary, { force: true });
              }
            }
          } finally {
            await unlock();
          }
          return json({ saved: true });
        }
        if (request.method === "GET" && segments[3] === "preview") {
          const scene = project.inspection.document.scenes.find(
            (s) => s.sceneId === decodeURIComponent(segments[4] ?? ""),
          );
          if (!scene?.preview) throw new Error("Preview unavailable");
          const file = within(path.dirname(project.scenePath), scene.preview);
          await noSymlinkPath(project.sourceRoot, file);
          return await sendFile(file, "image/png");
        }
        if (request.method === "GET" && segments[3] === "validation") {
          const relative = segments.slice(4).join("/") || "report.html";
          if (
            !/^(report\.(html|json)|(reconstructed|references|differences)\/[a-f0-9]+\.png)$/.test(
              relative,
            )
          )
            throw new Error("Unsupported result path");
          const file = within(project.root, `validation/${relative}`);
          await noSymlinkPath(project.root, file);
          return await sendFile(
            file,
            relative.endsWith(".png")
              ? "image/png"
              : relative.endsWith(".html")
                ? "text/html"
                : "application/json",
          );
        }
      }
      json({ error: "Not found" }, 404);
    } catch (error) {
      json({ error: diagnosticRu(String(error)) }, 400);
    }
  });
  const cleanup = setInterval(() => {
    for (const [token, item] of pending)
      if (item.expires < Date.now()) {
        pending.delete(token);
        void rm(item.folder, { recursive: true, force: true });
      }
  }, 60000);
  cleanup.unref();
  server.once("close", () => {
    clearInterval(cleanup);
    for (const item of pending.values())
      void rm(item.folder, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
function countNodes(children: unknown[]): number {
  return children.reduce<number>(
    (n, node) =>
      n +
      1 +
      (node &&
      typeof node === "object" &&
      "children" in node &&
      Array.isArray(node.children)
        ? countNodes(node.children)
        : 0),
    0,
  );
}
