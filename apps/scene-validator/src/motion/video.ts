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
  } = {},
) {
  if ((options.renderer ?? renderingMode()) === "browser-compat")
    return exportBrowserVideo(projectRoot, onProgress);
  const unlock = await lockProject(projectRoot);
  let encoder: ReturnType<typeof spawn> | undefined;
  let temporary: string | undefined;
  try {
    const project = await loadProject(projectRoot),
      doc = await readMotion(project),
      state = doc.state;
    const binary = process.env.MOTION_FFMPEG_BIN ?? ffmpegPath;
    if (typeof binary !== "string")
      throw new Error(
        "FFmpeg недоступен. Переустановите зависимости или задайте MOTION_FFMPEG_BIN.",
      );
    const renders = await safeDirectory(projectRoot, "renders");
    const name = `motion-${randomUUID()}.mp4`;
    temporary = path.join(renders, "." + name);
    const first = await renderNativeFrame(project, state, 0, {
      signal: options.signal,
      encoding: "rgba",
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
        `${state.settings.width}x${state.settings.height}`,
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
              encoding: "rgba",
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
      motionRevision: doc.revision,
      settings: state.settings,
      sourceFingerprint: project.inspection.fingerprint,
      warnings: [...warnings],
      renderer: first.renderer,
      fonts: [...usedFonts.values()],
      environment: first.environment,
      encodedSize: {
        width: Math.ceil(state.settings.width / 2) * 2,
        height: Math.ceil(state.settings.height / 2) * 2,
      },
      inputEncoding: "rgba",
      frameDigests,
      renderedAt: new Date().toISOString(),
    });
    return {
      file: name,
      revision: doc.revision,
      frames: state.settings.durationFrames,
      fps: state.settings.fps,
      warnings: [...warnings],
      renderer: first.renderer,
      fonts: [...usedFonts.values()],
      environment: first.environment,
      encodedSize: {
        width: Math.ceil(state.settings.width / 2) * 2,
        height: Math.ceil(state.settings.height / 2) * 2,
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
