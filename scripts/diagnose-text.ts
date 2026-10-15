import { cp, mkdtemp, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { loadProject } from "../apps/scene-validator/src/project.ts";
import { readMotion } from "../apps/scene-validator/src/motion/store.ts";
import { motionHtml } from "../apps/scene-validator/src/motion/presentation.ts";
import { codeVersions } from "../apps/scene-validator/src/harness/versions.ts";
import { textRasterQA } from "../apps/scene-validator/src/motion/qa/text.ts";
const args = process.argv.slice(2),
  arg = (name: string, fallback?: string) => {
    const i = args.indexOf("--" + name);
    return i < 0 ? fallback : args[i + 1];
  };
if (!arg("project") || !arg("target") || !arg("scene"))
  throw new Error("--project PATH --target ID --scene ID required");
const original = path.resolve(arg("project")!),
  targetId = arg("target")!,
  sceneId = arg("scene")!,
  output = path.resolve(arg("output", "artifacts/text-quality/" + Date.now())!);
if (output === original || output.startsWith(original + path.sep))
  throw new Error("Diagnostic output must be outside the source project");
const temporary = await mkdtemp(
  path.join(process.env.TMPDIR ?? "/tmp", "akella-text-diagnostic-"),
);
let browser;
try {
  await cp(original, temporary, {
    recursive: true,
    filter: (p) =>
      !/\/(?:ai|harness|qa|renders|validation|history)(?:\/|$)/.test(p),
  });
  const project = await loadProject(temporary),
    motionDocument = await readMotion(project);
  const run = arg("run");
  if (run) {
    if (!/^[a-f0-9-]{36}$/.test(run)) throw new Error("Invalid run ID");
    const execution = JSON.parse(
      await readFile(
        path.join(original, "motion/ai", run, "execution.json"),
        "utf8",
      ),
    );
    if (execution.revision !== motionDocument.revision)
      throw new Error(
        "Saved run revision differs from current state; use a verified historical copy, not an invented replay",
      );
  }
  const from = Number(arg("from", "0")),
    to = Number(
      arg("to", String(motionDocument.state.settings.durationFrames - 1)),
    );
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < from ||
    to >= motionDocument.state.settings.durationFrames ||
    to - from > 120
  )
    throw new Error("Valid bounded frame range (maximum121 frames) required");
  const selected = motionDocument.state.animations.filter(
    (a) => a.targetId === targetId && a.sceneId === sceneId,
  );
  if (!selected.some((a) => a.text))
    throw new Error("Target has no native segmented text animation");
  const stagger = arg("stagger");
  if (stagger !== undefined) {
    const frames = Number(stagger);
    if (!Number.isInteger(frames) || frames < 0 || frames > 1000)
      throw new Error("Invalid stagger");
    for (const a of selected) if (a.text) a.text.staggerFrames = frames;
  }
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ headless: true });
  const crop = arg("crop")?.split(",").map(Number);
  if (
    crop &&
    (crop.length !== 4 ||
      crop.some((v) => !Number.isFinite(v)) ||
      crop[2] <= 0 ||
      crop[3] <= 0 ||
      crop[0] < 0 ||
      crop[1] < 0 ||
      crop[0] + crop[2] > motionDocument.state.settings.width ||
      crop[1] + crop[3] > motionDocument.state.settings.height)
  )
    throw new Error("Invalid crop x,y,width,height");
  const variants = arg("variants", "A,B,C,D")!.split(",");
  if (variants.some((v) => !["A", "B", "C", "D"].includes(v)))
    throw new Error("Invalid ablation variant");
  const summaries = [];
  for (const variant of variants) {
    const state = structuredClone(motionDocument.state);
    state.animations = state.animations.filter(
      (a) =>
        a.targetId !== targetId ||
        a.sceneId !== sceneId ||
        a.effect !== "fadeIn" ||
        ["B", "D"].includes(variant),
    );
    state.expressions = state.expressions?.filter(
      (e) =>
        e.targetId !== targetId ||
        e.sceneId !== sceneId ||
        ["C", "D"].includes(variant),
    );
    const page = await browser.newPage({
      viewport: { width: state.settings.width, height: state.settings.height },
      deviceScaleFactor: 1,
    });
    await page.setContent((await motionHtml(project, state)).html);
    await page.evaluate(() => window.motionReady);
    if (args.includes("--isolate"))
      await page.evaluate(
        ({ targetId, sceneId }) => {
          const node = [
            ...document.querySelectorAll("[data-motion-target]"),
          ].find(
            (n) =>
              n.getAttribute("data-motion-target") === targetId &&
              n.closest<HTMLElement>("[data-motion-scene]")?.dataset
                .motionScene === sceneId,
          )!;
          const svg = node.closest("svg")!;
          const pending: Element[] = [svg];
          while (pending.length) {
            const parent = pending.pop()!;
            for (const child of [...parent.children]) {
              if (child === node || child.tagName.toLowerCase() === "defs")
                continue;
              if (child.contains(node)) pending.push(child);
              else child.remove();
            }
          }
          svg.style.background = "#101010";
        },
        { targetId, sceneId },
      );
    const directory = path.join(output, variant);
    await mkdir(directory, { recursive: true });
    const rows = [],
      images = new Map<number, Buffer>();
    const sampleFrames = new Set(
      Array.from({ length: 16 }, (_, i) =>
        Math.round(from + ((to - from) * i) / 15),
      ),
    );
    for (let frame = from; frame <= to; frame++) {
      await page.evaluate((f) => window.motionFrame(f), frame);
      rows.push(
        await page.evaluate(
          ({ targetId, sceneId }) =>
            window
              .motionTextDiagnostics()
              .find((t) => t.targetId === targetId && t.sceneId === sceneId),
          { targetId, sceneId },
        ),
      );
      const png = await page.screenshot({
        clip: crop
          ? { x: crop[0], y: crop[1], width: crop[2], height: crop[3] }
          : undefined,
      });
      if (args.includes("--all-frames") || args.includes("--video"))
        await writeFile(path.join(directory, frame + ".png"), png);
      if (sampleFrames.has(frame)) images.set(frame, png);
    }
    await writeFile(
      path.join(output, variant + "-frames.json"),
      JSON.stringify(rows, null, 2),
    );
    const contact = await browser.newPage({
      viewport: { width: 960, height: 900 },
    });
    await contact.setContent(
      "<html><style>body{margin:0;background:#202020;color:#fff;font:14px Arial;display:grid;grid-template-columns:repeat(4,240px)}figure{margin:0}img{width:240px;height:auto;display:block}</style><body>" +
        [...images]
          .map(
            ([frame, png]) =>
              `<figure><figcaption>${variant}: frame ${frame}</figcaption><img src="data:image/png;base64,${png.toString("base64")}"></figure>`,
          )
          .join("") +
        "</body></html>",
    );
    await contact.screenshot({
      path: path.join(output, variant + "-contact.png"),
      fullPage: true,
    });
    await contact.close();
    const middle = Math.min(
      to,
      selected[0].startFrame + Math.floor(selected[0].durationFrames / 2),
    );
    await page.evaluate((f) => window.motionFrame(f), middle);
    const detail = await page.evaluate(
      ({ targetId, sceneId }) =>
        window
          .motionTextDiagnostics()
          .find((t) => t.targetId === targetId && t.sceneId === sceneId),
      { targetId, sceneId },
    );
    const raster = [];
    for (let i = 0; i < Math.min(detail?.units.length ?? 0, 3); i++)
      raster.push(await textRasterQA(page, targetId, sceneId, i));
    summaries.push({
      variant,
      detail,
      raster,
      artisticQuality: "NOT_TESTED",
      frames: rows.length,
    });
    if (args.includes("--video"))
      await promisify(execFile)(
        createRequire(import.meta.url)("ffmpeg-static"),
        [
          "-y",
          "-v",
          "error",
          "-framerate",
          String(state.settings.fps),
          "-start_number",
          String(from),
          "-i",
          path.join(directory, "%d.png"),
          "-vf",
          "pad=ceil(iw/2)*2:ceil(ih/2)*2",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          path.join(output, variant + ".mp4"),
        ],
      );
    await page.close();
  }
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        schemaVersion: "text-diagnostic/1",
        projectId: project.config.projectId,
        projectRevision: motionDocument.revision,
        sourceRun: run ?? null,
        sourceFingerprint: project.inspection.fingerprint,
        targetId,
        sceneId,
        range: { from, to, fps: motionDocument.state.settings.fps },
        copyOnlyStaggerOverride: stagger ?? null,
        versions: await codeVersions(),
        variants: summaries,
      },
      null,
      2,
    ),
  );
  console.log(output);
} finally {
  await browser?.close();
  await rm(temporary, { recursive: true, force: true });
}
