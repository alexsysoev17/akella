/** Explicit live-provider qualification on a synthetic circle. Never runs with ordinary npm test. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { identityFixture, node } from "../apps/scene-validator/tests/identity-fixture.js";
import { loadProject } from "../apps/scene-validator/src/project.js";
import { executeMotion } from "../apps/scene-validator/src/motion/service.js";
import { readMotion, changeMotion } from "../apps/scene-validator/src/motion/store.js";
import { renderProjectFrame } from "../apps/scene-validator/src/native/service.js";
import { closeNativeRenderer } from "../apps/scene-validator/src/native/client.js";
import { exportVideo } from "../apps/scene-validator/src/motion/video.js";
if (!process.argv.includes("--live")) throw new Error("Live external-provider evaluation requires --live; only synthetic Circle data is sent.");
process.env.AKELLA_RENDERER = "native";
const crossScene = process.argv.includes("--cross-scene");
const fromAt = process.argv.indexOf("--from");
const firstTurn = fromAt >= 0 ? Number(process.argv[fromAt + 1]) - 1 : 1;
const resumeAt = process.argv.indexOf("--resume");
const resumedRoot = resumeAt >= 0 ? path.resolve(process.argv[resumeAt + 1]) : undefined;
if (resumedRoot && (!Number.isInteger(firstTurn) || firstTurn < 1 || firstTurn > (crossScene ? 8 : 4))) throw new Error("--from must be 2..5 when resuming");
const f = await identityFixture(2, scenes => scenes.forEach((s, i) => { const c = node("c" + i, crossScene ? "круг" : "Circle", i ? 135 : 25, i ? 65 : 25, 24, 24); c.type = "ELLIPSE"; s.children = [c]; }));
f.state.settings.fps = 12; f.state.settings.durationFrames = 48;
f.state.blocks.forEach((b, i) => { b.startFrame = i * 24; b.durationFrames = 24; });
if (resumedRoot) {
  assert.ok(resumedRoot.includes("identity-test-"), "Only synthetic fixtures can be resumed");
  f.project = await loadProject(resumedRoot);
  assert.ok(f.project.inspection.document.scenes.every(s => s.children.every(c => c && typeof c === "object" && "name" in c && ["Circle", "круг"].includes(String(c.name)))));
}
let doc = await readMotion(f.project);
if (!resumedRoot) await changeMotion(f.project.root, { expectedRevision: doc.revision, request: "Synthetic circle fixture", operations: [{ type: "setProjectSettings", settings: f.state.settings }, { type: "setBlocks", blocks: f.state.blocks }] });
const prompts = crossScene ? [
  "круг в начале видео за секунду перемещается в положение как на сцене 2 - анимация линейная",
  "сделай очень медленное начало и конец, резко в середине",
  "пусть круг двигается линейно",
  "добавь затухающие колебания после конца движения",
  "сделай колебания сильнее",
  "добавь к кругу эффект wiggle",
  "сделай wiggle медленнее и слабее",
  "убери wiggle, но сохрани всю остальную анимацию",
  "пусть круг двигается линейно также пусть у него будут затухающие колебания инерция после конца движения",
] : [
  "Переведи Circle из первого состояния во второе за одну секунду линейно, начиная с нулевого кадра.",
  "Измени только easing перехода Circle на easeInOutCubic.",
  "Добавь Circle непрерывный плавный Wiggle на весь ролик.",
  "Уменьши амплитуду Wiggle Circle вдвое.",
  "Удали только Wiggle Circle, сохрани переход.",
];
const report: { fixture: string; provider: string; status: string; turns: unknown[]; error?: string; video?: unknown } = { fixture: f.project.root, provider: "codex-sdk/live", status: "RUNNING", turns: [] };
const output = path.resolve(crossScene ? "artifacts/cross-scene-live/report.json" : "artifacts/motion-tools-live/report.json");
await mkdir(path.dirname(output), { recursive: true });
let base: unknown = resumedRoot ? structuredClone(crossScene ? doc.state.objectTransitions![0] : doc.state.objectTransitions) : undefined, amplitudes: Map<string, number> | undefined = resumedRoot ? new Map(doc.state.expressions?.map(e => [e.expressionId, e.parameters.amplitude])) : undefined;
try {
  for (let i = resumedRoot ? firstTurn : 0; i < prompts.length; i++) {
    doc = await readMotion(f.project);
    const before = doc, started = performance.now();
    const result = await executeMotion(f.project, { mode: "edit", request: prompts[i], ...(crossScene ? {} : { selectedObjectId: "c0", activeSceneId: "s0" }), expectedRevision: doc.revision, settings: { provider: "codex-sdk", model: "" } }, stage => console.error(`turn ${i + 1}: ${stage}`), { config: { maxLLMCalls: 1, maxRepairAttempts: 0 } });
    const runId = result.id;
    const stored = JSON.parse(await readFile(path.join(f.project.root, "motion/harness/runs", runId, "run.json"), "utf8"));
    doc = await readMotion(f.project);
    report.turns.push({ index: i + 1, runId, reconciliation: result.reconciliation, elapsedMs: performance.now() - started, metrics: stored.metrics, calls: stored.calls.map((c: { usage?: unknown; latencyMs?: number; status?: string }) => ({ usage: c.usage, latencyMs: c.latencyMs, status: c.status })) });
    assert.equal(result.reconciliation?.status, "SUCCESS");
    assert.equal(doc.cursor, before.cursor + 1);
    if (crossScene) {
      assert.equal(doc.state.objectTransitions!.length, 1);
      const transition = doc.state.objectTransitions![0];
      assert.equal(transition.durationFrames, 12); assert.equal(transition.startFrame, 0);
      if (i === 0) base = structuredClone(transition);
      const original = base as typeof transition;
      assert.deepEqual({ ...transition, easing: original.easing }, original, "base identity/timing/reference states preserved");
      if (i === 2 || i === 8) assert.equal(transition.easing, "linear");
      const inertia = (doc.state.expressions ?? []).filter(e => e.type === "inertialOvershoot");
      if (i >= 3) { assert.equal(inertia.length, 2); assert.ok(inertia.every(e => e.transitionId === transition.transitionId && e.startFrame === 12)); }
      if (i === 4) assert.ok(inertia.every(e => e.parameters.amplitude > before.state.expressions!.find(old => old.expressionId === e.expressionId)!.parameters.amplitude));
      if (i === 5 || i === 6) {
        const wiggles = doc.state.expressions!.filter(e => e.type === "wiggle");
        assert.equal(wiggles.length, 2); assert.ok(wiggles.every(e => e.ownership?.scope === "logicalObject" && e.durationFrames === 48));
        if (i === 6) assert.ok(wiggles.every(e => e.parameters.amplitude < before.state.expressions!.find(old => old.expressionId === e.expressionId)!.parameters.amplitude));
        const { renderNativeFrame } = await import("../apps/scene-validator/src/native/client.js");
        for (const frame of [23, 24, 28, 47]) {
          const image = await renderProjectFrame(f.project, frame, { encoding: "rgba" });
          const plain = await renderNativeFrame(f.project, { ...doc.state, expressions: inertia }, frame, { encoding: "rgba" });
          assert.notDeepEqual(image.png, plain.png);
        }
      }
      if (i === 7) { assert.equal(doc.state.expressions!.length, 2); assert.deepEqual(inertia, before.state.expressions!.filter(e => e.type === "inertialOvershoot")); }
      if (i === 8) {
        const frame = await renderProjectFrame(f.project, 24, { encoding: "rgba" });
        const video = await exportVideo(f.project.root, () => {}, { renderer: "native" });
        assert.ok("frameDigests" in video); assert.equal(video.frameDigests.find(d => d.frame === 24)?.sha256, createHash("sha256").update(frame.png).digest("hex")); report.video = video;
      }
      await writeFile(output, JSON.stringify(report, null, 2));
      continue;
    }
    if (i === 0) { assert.equal(doc.state.objectTransitions!.length, 1); assert.equal(doc.state.objectTransitions![0].durationFrames, 12); assert.equal(doc.state.objectTransitions![0].easing, "linear"); base = structuredClone(doc.state.objectTransitions); }
    if (i === 1) { const previous = (base as NonNullable<typeof doc.state.objectTransitions>)[0]; assert.deepEqual(doc.state.objectTransitions, [{ ...previous, easing: "easeInOutCubic" }]); base = structuredClone(doc.state.objectTransitions); }
    if (i >= 2) assert.deepEqual(doc.state.objectTransitions, base);
    if (i === 2) {
      assert.ok(doc.state.expressions?.length); assert.ok(doc.state.expressions!.every(e => e.type === "wiggle" && e.transitionId));
      amplitudes = new Map(doc.state.expressions!.map(e => [e.expressionId, e.parameters.amplitude]));
      const frame = await renderProjectFrame(f.project, 47, { encoding: "rgba" });
      const video = await exportVideo(f.project.root, () => {}, { renderer: "native" });
      assert.ok("frameDigests" in video); assert.equal(video.frameDigests.find(d => d.frame === 47)?.sha256, createHash("sha256").update(frame.png).digest("hex"));
      report.video = video;
    }
    if (i === 3) { assert.equal(doc.state.expressions!.length, amplitudes!.size); assert.ok(doc.state.expressions!.every(e => Math.abs(e.parameters.amplitude - amplitudes!.get(e.expressionId)! * .5) < 1e-10)); }
    if (i === 4) assert.equal(doc.state.expressions?.length, 0);
    await writeFile(output, JSON.stringify(report, null, 2));
  }
  report.status = resumedRoot ? "PASSED_RESUMED" : "PASSED";
} catch (error) { report.status = "FAILED"; report.error = String(error); process.exitCode = 1; }
finally { await closeNativeRenderer(); await writeFile(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ output, status: report.status, completedTurns: report.turns.length, error: report.error, fixture: f.project.root })); }
