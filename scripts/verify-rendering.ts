import { loadProject } from "../apps/scene-validator/src/project.js";
import { readMotion } from "../apps/scene-validator/src/motion/store.js";
import { motionHtml } from "../apps/scene-validator/src/motion/presentation.js";
import { inspectObject } from "../apps/scene-validator/src/motion/qa/geometry.js";
import { motionQA } from "../apps/scene-validator/src/motion/qa/render.js";
import { inventory, fingerprint } from "../apps/scene-validator/src/files.js";
import { chromium } from "playwright";
import { mkdir, writeFile, cp } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
const args = process.argv.slice(2);
const arg = (name: string, defaultValue?: string) => {
  const i = args.indexOf("--" + name);
  const value = i >= 0 ? args[i + 1] : defaultValue;
  if (!value) throw new Error("--" + name + " required");
  return value;
};
const project = await loadProject(arg("project")),
  state = (await readMotion(project)).state,
  out = path.resolve(arg("output", "artifacts/rendering-check")),
  browser = await chromium.launch({ headless: true });
await mkdir(out, { recursive: true });
const before = fingerprint(await inventory(project.sourceRoot));
const report = [];
try {
  for (const a of state.animations.filter(
    (a) => a.enabled && (a.effect === "trimPath" || a.effect === "maskReveal"),
  )) {
    const page = await browser.newPage({
      viewport: { width: state.settings.width, height: state.settings.height },
    });
    await page.setContent((await motionHtml(project, state)).html);
    await page.evaluate(() => window.motionReady);
    const samples = [];
    for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
      const frame = Math.min(
        state.settings.durationFrames - 1,
        Math.round(a.startFrame + a.durationFrames * progress),
      );
      await page.evaluate((f) => window.motionFrame(f), frame);
      const file =
        a.animationId.replace(/[^a-zA-Z0-9_-]/g, "_") + "-" + progress + ".png";
      await page.screenshot({ path: path.join(out, file) });
      samples.push({
        progress,
        frame,
        file,
        diagnostics: await inspectObject(page, a.sceneId, a.targetId),
      });
    }
    await page.close();
    const relative = "motion/qa/rendering-check-" + randomUUID();
    const qa = await motionQA(
      project,
      state,
      relative,
      "Rendering geometry integrity",
      {
        ...state,
        animations: state.animations.filter(
          (e) => e.animationId !== a.animationId,
        ),
      },
      { sceneId: a.sceneId, targetId: a.targetId },
    );
    await cp(
      path.join(project.root, relative),
      path.join(out, a.animationId.replace(/[^a-zA-Z0-9_-]/g, "_") + "-qa"),
      { recursive: true },
    );
    report.push({ animation: a, samples, qa });
  }
  await writeFile(
    path.join(out, "report.json"),
    JSON.stringify(
      {
        sourceUnchanged:
          before === fingerprint(await inventory(project.sourceRoot)),
        report,
      },
      null,
      2,
    ),
  );
  console.log(out);
} finally {
  await browser.close();
}
