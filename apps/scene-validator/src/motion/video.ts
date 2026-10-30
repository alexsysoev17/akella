import {previewScales,type RenderQuality} from "../native/quality.js";
import {validateMotion} from "./operations.js";
import {numericQA} from "./qa/numeric.js";
import {statePresentation} from "./transitions.js";
import {compositionQA} from "../native/composition-qa.js";
import { spawn } from "node:child_process";
import { renderNativeFrame, renderingMode } from "../native/client.js";
import { exportBrowserVideo } from "./video-browser.js";
import { createRequire } from "node:module";
const ffmpegPath: unknown = createRequire(import.meta.url)("ffmpeg-static");
import { createHash, randomUUID } from "node:crypto";
import { writeFile, rm, rename } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { loadProject } from "../project.js";
import {
  safeDirectory,
  lockProject,
  atomicJson,
  inventory,
  fingerprint,
} from "../files.js";
import { readMotion } from "./store.js";

export async function exportVideo(
  projectRoot: string,
  onProgress: (n: number, total: number) => void = () => {},
  options: {
    signal?: AbortSignal;
    renderer?: "native" | "browser-compat";
    draftQuality?:RenderQuality;
  } = {},
) {
  if ((options.renderer ?? renderingMode()) === "browser-compat") {
    if(options.draftQuality)throw Error('DRAFT_REQUIRES_NATIVE_RENDERER');
    return exportBrowserVideo(projectRoot, onProgress);
  }
  const unlock = await lockProject(projectRoot);
  let encoder: ReturnType<typeof spawn> | undefined;
  let temporary: string | undefined;
  try {
    const project = await loadProject(projectRoot),
      doc = await readMotion(project),
      state = doc.state;
    const renderScale=options.draftQuality?previewScales[options.draftQuality]:1;
    if(!(renderScale>0))throw Error('INVALID_DRAFT_QUALITY');
    validateMotion(state,project);
    const numeric=numericQA(state,'',statePresentation(project,state));
    const fullComposition=await compositionQA(project,state,'motion/qa/export-'+randomUUID(),{signal:options.signal,scale:options.draftQuality?renderScale:1});
    const exportQA={level:options.draftQuality?'DRAFT_TECHNICAL':'FULL_TECHNICAL',renderScale:options.draftQuality?renderScale:1,numeric:numeric.checks,composition:fullComposition,status:[...numeric.checks,...fullComposition.checks].some(c=>c.status==='FAILED')?'FAILED':'PASSED',artistic:'NOT_TESTED'};
    if(exportQA.status==='FAILED')throw Object.assign(Error('EXPORT_QA_FAILED'),{code:'EXPORT_QA_FAILED',report:exportQA});
    const binary = process.env.MOTION_FFMPEG_BIN ?? ffmpegPath;
    if (typeof binary !== "string")
      throw new Error(
        "FFmpeg недоступен. Переустановите зависимости или задайте MOTION_FFMPEG_BIN.",
      );
    const renders = await safeDirectory(projectRoot, "renders");
    const name = `${options.draftQuality?'draft-'+options.draftQuality:'motion'}-${randomUUID()}.mp4`;
    temporary = path.join(renders, "." + name);
    const first = await renderNativeFrame(project, state, 0, {
      signal: options.signal,
      encoding: "rgba",scale:renderScale,
    });
    const warnings = new Set(first.warnings);
    const usedFonts = new Map(first.fonts.map((font) => [font.family, font]));
    let stderr = "";
    encoder = spawn(
      binary,
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "rawvideo",
        "-pixel_format",
        "rgba",
        "-video_size",
        `${first.width}x${first.height}`,
        "-framerate",
        String(state.settings.fps),
        "-i",
        "pipe:0",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-vf",
        "pad=ceil(iw/2)*2:ceil(ih/2)*2",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        temporary,
      ],
      { stdio: ["pipe", "pipe", "pipe"], shell: false },
    );
    const completed = new Promise<void>((resolve, reject) => {
      encoder!.once("error", reject);
      encoder!.stderr!.on("data", (b) => {
        stderr = (stderr + b).slice(-8000);
      });
      encoder!.once("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`FFmpeg: ${stderr || code}`)),
      );
    });
    completed.catch(() => {});
    encoder!.stdin!.on("error", () => {});
    const frameDigests: { frame: number; sha256: string }[] = [];
    for (let frame = 0; frame < state.settings.durationFrames; frame++) {
      options.signal?.throwIfAborted();
      const rendered =
        frame === 0
          ? first
          : await renderNativeFrame(project, state, frame, {
              signal: options.signal,
              encoding: "rgba",scale:renderScale,
            });
      rendered.warnings.forEach((w) => warnings.add(w));
      for (const font of rendered.fonts) usedFonts.set(font.family, font);
      const png = rendered.png;
      if (
        [
          0,
          Math.floor(state.settings.durationFrames / 2),
          state.settings.durationFrames - 1,
        ].includes(frame)
      )
        frameDigests.push({
          frame,
          sha256: createHash("sha256").update(png).digest("hex"),
        });
      if (!encoder!.stdin!.write(png))
        await Promise.race([
          once(encoder!.stdin!, "drain"),
          completed.then(() => {
            throw new Error("FFmpeg остановился раньше завершения");
          }),
        ]);
      onProgress(frame + 1, state.settings.durationFrames);
    }
    encoder!.stdin!.end();
    await completed;
    encoder = undefined;
    if (
      fingerprint(await inventory(project.sourceRoot)) !==
      project.inspection.fingerprint
    )
      throw new Error(
        "Исходники изменились во время рендера; результат не опубликован",
      );
    await rename(temporary, path.join(renders, name));
    temporary = undefined;
    await atomicJson(path.join(renders, name + ".json"), {
      mode:options.draftQuality?'draft':'final',quality:options.draftQuality??'full',renderScale,projectResolution:{width:state.settings.width,height:state.settings.height},renderResolution:{width:first.width,height:first.height},
      motionRevision: doc.revision,
      settings: state.settings,
      sourceFingerprint: project.inspection.fingerprint,
      warnings: [...warnings],
      renderer: first.renderer,
      fonts: [...usedFonts.values()],
      environment: first.environment,
      encodedSize: {
        width: Math.ceil(first.width / 2) * 2,
        height: Math.ceil(first.height / 2) * 2,
      },
      inputEncoding: "rgba",
      frameDigests,
      qa:exportQA,
      renderedAt: new Date().toISOString(),
    });
    return {
      mode:options.draftQuality?'draft':'final',quality:options.draftQuality??'full',renderScale,projectResolution:{width:state.settings.width,height:state.settings.height},renderResolution:{width:first.width,height:first.height},qa:exportQA,
      file: name,
      revision: doc.revision,
      frames: state.settings.durationFrames,
      fps: state.settings.fps,
      warnings: [...warnings],
      renderer: first.renderer,
      fonts: [...usedFonts.values()],
      environment: first.environment,
      encodedSize: {
        width: Math.ceil(first.width / 2) * 2,
        height: Math.ceil(first.height / 2) * 2,
      },
      inputEncoding: "rgba",
      frameDigests,
    };
  } finally {
    encoder?.kill("SIGTERM");
    if (temporary) await rm(temporary, { force: true });
    await unlock();
  }
}
