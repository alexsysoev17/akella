import {
  renderingMode,
  renderNativeFrame,
  compareNativeFrames,
} from "../native/client.js";
import { chromium } from "playwright";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { LoadedProject } from "../types.js";
import { readMotion } from "../motion/store.js";
import { motionHtml } from "../motion/presentation.js";
import { exportVideo } from "../motion/video.js";
/** Explicit benchmark/export mode only; never run on an ordinary user prompt. */
export async function evaluateVideoConsistency(
  project: LoadedProject,
  requestedFrames?: number[],
) {
  const doc = await readMotion(project),
    s = doc.state;
  const reveals = s.animations.filter((a) => a.effect === "trimPath"),
    slides = s.animations.filter((a) => a.effect.startsWith("slide"));
  const frames = [
    ...new Set(
      (
        requestedFrames ?? [
          ...reveals.map(
            (a) => a.startFrame + Math.floor(a.durationFrames / 2),
          ),
          ...(slides[0]
            ? [
                slides[0].startFrame + Math.floor(slides[0].durationFrames / 2),
                slides[0].startFrame + slides[0].durationFrames + 4,
              ]
            : []),
          ...(s.expressions?.length
            ? [
                s.expressions.at(-1)!.startFrame +
                  Math.floor(s.expressions.at(-1)!.durationFrames / 2),
              ]
            : []),
        ]
      ).map((f) =>
        Math.max(0, Math.min(s.settings.durationFrames - 1, Math.round(f))),
      ),
    ),
  ].slice(0, 8);
  if (!frames.length)
    return { status: "NOT_TESTED", reason: "NO_RELEVANT_FRAMES" };
  if (renderingMode() === "native") {
    const video = await exportVideo(project.root),
      samples = [];
    for (const frame of frames) {
      const native = await renderNativeFrame(project, s, frame),
        decoded = await promisify(execFile)(
          createRequire(import.meta.url)("ffmpeg-static") as string,
          [
            "-v",
            "error",
            "-i",
            path.join(project.root, "renders", video.file),
            "-vf",
            `select=eq(n\\,${frame}),crop=${s.settings.width}:${s.settings.height}:0:0:exact=1`,
            "-frames:v",
            "1",
            "-f",
            "image2pipe",
            "-vcodec",
            "png",
            "-",
          ],
          { encoding: "buffer", maxBuffer: 20000000 },
        ),
        difference = await compareNativeFrames(native.png, decoded.stdout);
      samples.push({
        frame,
        meanAbsolutePixelDifference: difference.meanAbsoluteError,
        status: difference.meanAbsoluteError < 3 ? "PASSED" : "FAILED",
      });
    }
    return {
      status: samples.every((s) => s.status === "PASSED") ? "PASSED" : "FAILED",
      motionRevision: doc.revision,
      video: video.file,
      samples,
      tolerance: 3,
      method:
        "Actual shared Skia native frame vs decoded H264 MP4; average absolute RGBA difference",
    };
  }
  const video = await exportVideo(project.root),
    browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: s.settings.width, height: s.settings.height },
    });
    await page.route("**/*", (r) =>
      r.request().url().startsWith("data:") ? r.continue() : r.abort(),
    );
    await page.setContent((await motionHtml(project, s)).html);
    await page.evaluate(() => window.motionReady);
    const samples = [];
    for (const frame of frames) {
      await page.evaluate((f) => window.motionFrame(f), frame);
      const png = await page.screenshot();
      const decoded = await promisify(execFile)(
        createRequire(import.meta.url)("ffmpeg-static") as string,
        [
          "-v",
          "error",
          "-i",
          path.join(project.root, "renders", video.file),
          "-vf",
          `select='eq(n,${frame})'`,
          "-frames:v",
          "1",
          "-f",
          "image2pipe",
          "-vcodec",
          "png",
          "-",
        ],
        { encoding: "buffer", maxBuffer: 20000000 },
      );
      const difference = await page.evaluate(
        async (srcs) => {
          const pixels = await Promise.all(
            srcs.map(async (src) => {
              const img = new Image();
              img.src = src;
              await img.decode();
              const c = document.createElement("canvas");
              c.width = img.width;
              c.height = img.height;
              const ctx = c.getContext("2d")!;
              ctx.drawImage(img, 0, 0);
              return ctx.getImageData(0, 0, c.width, c.height).data;
            }),
          );
          let sum = 0;
          for (let i = 0; i < pixels[0].length; i++)
            sum += Math.abs(pixels[0][i] - pixels[1][i]);
          return sum / pixels[0].length;
        },
        [png, decoded.stdout].map(
          (b) => "data:image/png;base64," + b.toString("base64"),
        ),
      );
      samples.push({
        frame,
        meanAbsolutePixelDifference: difference,
        status: difference < 3 ? "PASSED" : "FAILED",
      });
    }
    return {
      status: samples.every((s) => s.status === "PASSED") ? "PASSED" : "FAILED",
      motionRevision: doc.revision,
      video: video.file,
      samples,
      tolerance: 3,
      method:
        "Actual Chromium Preview vs decoded H264 MP4; average absolute RGBA difference",
    };
  } finally {
    await browser.close();
  }
}
