import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { createRequire } from "node:module";
const ffmpegPath: unknown = createRequire(import.meta.url)("ffmpeg-static");
import { randomUUID } from "node:crypto";
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
import { motionHtml } from "./presentation.js";
export async function exportVideo(
  projectRoot: string,
  onProgress: (n: number, total: number) => void = () => {},
) {
  const unlock = await lockProject(projectRoot);
  let browser;
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
    const presentation = await motionHtml(project, state);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: state.settings.width, height: state.settings.height },
      deviceScaleFactor: 1,
    });
    await page.route("**/*", (route) =>
      route.request().url().startsWith("data:")
        ? route.continue()
        : route.abort(),
    );
    await page.setContent(presentation.html, { waitUntil: "load" });
    await page.evaluate(async () => {
      await window.motionReady;
    });
    let stderr = "";
    encoder = spawn(
      binary,
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "image2pipe",
        "-vcodec",
        "png",
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
    for (let frame = 0; frame < state.settings.durationFrames; frame++) {
      await page.evaluate((f) => window.motionFrame(f), frame);
      const png = await page.screenshot({ type: "png" });
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
      warnings: presentation.warnings,
      renderedAt: new Date().toISOString(),
    });
    return {
      file: name,
      revision: doc.revision,
      frames: state.settings.durationFrames,
      fps: state.settings.fps,
      warnings: presentation.warnings,
    };
  } finally {
    encoder?.kill("SIGTERM");
    await browser?.close();
    if (temporary) await rm(temporary, { force: true });
    await unlock();
  }
}
