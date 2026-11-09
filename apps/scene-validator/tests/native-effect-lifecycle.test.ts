import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { identityFixture, node } from "./identity-fixture.js";
import { objectRequirement } from "./intent-fixture.js";
import { validateIntentPlan } from "../src/motion/intent/planner.js";
import { compileTasks, compileRequirement } from "../src/motion/intent/compiler.js";
import { preflightIntentPlan } from "../src/motion/intent/execution.js";
import { applyOperations } from "../src/motion/operations.js";
import { readMotion, changeMotion } from "../src/motion/store.js";
import { renderProjectFrame } from "../src/native/service.js";
import { renderNativeFrame, closeNativeRenderer } from "../src/native/client.js";
import { exportVideo } from "../src/motion/video.js";
import { nativeMotionQA } from "../src/native/qa.js";
process.env.AKELLA_RENDERER = "native";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("native continuous Wiggle: production frames/QA/export share pixels, final-frame motion, seek and Undo/Redo", async () => {
  const f = await identityFixture(1, scenes => { scenes[0].children = [node("p", "Product", 80, 40)]; });
  try {
    f.state.settings.fps = 12; f.state.settings.durationFrames = 24; f.state.blocks[0].durationFrames = 24;
    const req = objectRequirement("r", "s0", "p", "Product", ["wiggle"], "Product всегда немного wiggle");
    req.parameters.lifetime = "scene";
    const plan = validateIntentPlan(f.project, req.sourceText, { schemaVersion: "1.0.0", requirements: [req], coverage: [{ sourceText: req.sourceText, requirementIds: ["r"], classification: "executable", explanation: "fixture" }], assumptions: [] }, 12, { state: f.state });
    assert.equal(preflightIntentPlan(f.project, f.state, plan).status, "PASSED");
    const operations = compileTasks(f.project, plan).flatMap(t => compileRequirement(f.project, f.state, plan, t).operations);
    const doc = await readMotion(f.project);
    const init = await changeMotion(f.project.root, { expectedRevision: doc.revision, request: "fixture settings", operations: [{ type: "setProjectSettings", settings: f.state.settings }, { type: "setBlockDuration", blockId: f.state.blocks[0].blockId, durationFrames: 24 }] });
    await changeMotion(f.project.root, { expectedRevision: init.document.revision, request: req.sourceText, operations });
    const committed = await readMotion(f.project), candidate = applyOperations(f.state, operations, f.project);
    assert.deepEqual(committed.state.expressions, candidate.expressions);
    const qa = await nativeMotionQA(f.project, committed.state, "motion/qa/wiggle-regression", req.sourceText, undefined, { sceneId: "s0", targetId: "p" });
    assert.ok(!qa.checks.some(c => c.status === "FAILED"));
    assert.ok(qa.checks.some(c => c.name === "wiggleBoundedDeterministic" && c.status === "PASSED"));
    const first = await renderProjectFrame(f.project, 23, { encoding: "rgba" });
    await renderProjectFrame(f.project, 7, { encoding: "rgba" });
    assert.deepEqual((await renderProjectFrame(f.project, 23, { encoding: "rgba" })).png, first.png);
    const bare = await renderNativeFrame(f.project, { ...committed.state, expressions: [] }, 23, { encoding: "rgba" });
    assert.notDeepEqual(first.png, bare.png);
    const video = await exportVideo(f.project.root, () => {}, { renderer: "native" });
    assert.equal(video.frames, 24);
    assert.ok("frameDigests" in video);
    assert.equal(video.frameDigests.find(d => d.frame === 23)?.sha256, sha(first.png));
    const undone = await changeMotion(f.project.root, { expectedRevision: committed.revision, request: "Undo", action: "undo" });
    assert.equal(undone.document.state.expressions?.length ?? 0, 0);
    const redone = await changeMotion(f.project.root, { expectedRevision: undone.document.revision, request: "Redo", action: "redo" });
    assert.deepEqual(redone.document.state.expressions, committed.state.expressions);
  } finally { await closeNativeRenderer(); await f.cleanup(); }
});
