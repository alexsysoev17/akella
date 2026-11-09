import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import fixture from "./fixtures/semantic-coverage-ribbons.json" with { type: "json" };
import { identityFixture, node } from "./identity-fixture.js";
import { registerProvider } from "../src/harness/providers/index.js";
import { executeMotion } from "../src/motion/service.js";
import { changeMotion, readMotion } from "../src/motion/store.js";
import { renderProjectFrame } from "../src/native/service.js";
import { closeNativeRenderer } from "../src/native/client.js";
import { exportVideo } from "../src/motion/video.js";
process.env.AKELLA_RENDERER = "native";
test("exact saved multi-scene Russian request → provenance recovery → two sequential true Trim Paths → native Preview/MP4", async () => {
  const f = await identityFixture(4, scenes => {
    scenes.forEach((scene, i) => {
      const names = [...new Set(fixture.graph.actions.filter(a => a.scene === `s${i}`).flatMap(a => a.targets))];
      scene.children = names.map((name, j) => {
        const n = node(`n${i}_${j}`, name, 10 + j * 22, 15 + j * 15, name.startsWith("лента") ? 140 : 20, 12);
        if (name.startsWith("лента")) {
          n.type = "VECTOR";
          n.properties = { ...n.properties, fills: [], strokeWeight: 3, strokeAlign: "CENTER",
            strokes: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }],
            vectorPaths: [{ data: "M0 0 C40 20 100 -20 140 0", windingRule: "NONZERO" }] };
        }
        return n;
      });
    });
  });
  let calls = 0;
  const stop = registerProvider("coverage-ribbons-fixture", () => ({ id: "coverage-ribbons-fixture", mode: "mock",
    capabilities: () => ({ structuredOutput: true, nativeToolCalling: false, cancellation: true, usage: false, nativeOutputTokenLimit: false }),
    generate: async () => { calls++; return { output: fixture.graph, usage: null, estimatedCost: null, latencyMs: 0, toolCalls: [], diagnostics: ["saved semantics adapted to synthetic geometry; no live provider"] }; } }));
  try {
    const initial = await readMotion(f.project);
    const result = await executeMotion(f.project, { request: fixture.prompt, mode: "create", expectedRevision: initial.revision,
      settings: { provider: "coverage-ribbons-fixture", model: "" } }, () => {}, { config: { maxLLMCalls: 1, maxRepairAttempts: 0 } });
    assert.equal(result.reconciliation?.status, "SUCCESS", JSON.stringify(result.reconciliation));
    assert.equal(calls, 1, "no coverage repair provider call");
    const after = await readMotion(f.project), ribbons = after.state.animations.filter(a => a.effect === "trimPath");
    assert.equal(ribbons.length, 2);
    const [one, two] = [...ribbons].sort((a,b) => a.startFrame - b.startFrame);
    assert.equal(two.startFrame, one.startFrame + one.durationFrames);
    assert.equal(after.state.timingDependencies?.length, 1);
    const resolution = JSON.parse(await readFile(path.join(f.project.root, "motion/ai", result.id, "intent-target-resolution.json"), "utf8"));
    assert.ok(resolution.some((e: { event: string }) => e.event === "SEMANTIC_RECOVERY"));
    const frames = [one.startFrame, one.startFrame + Math.floor(one.durationFrames / 2), two.startFrame + Math.floor(two.durationFrames / 2)];
    const previews = await Promise.all(frames.map(frame => renderProjectFrame(f.project, frame, { encoding: "rgba" })));
    const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
    assert.notEqual(hash(previews[0].png), hash(previews[1].png), "actual rendered reveal changes pixels");
    assert.notEqual(hash(previews[1].png), hash(previews[2].png));
    const video = await exportVideo(f.project.root, () => {}, { renderer: "native" });
    assert.ok("frameDigests" in video);
    for (const digest of video.frameDigests) {
      const preview = await renderProjectFrame(f.project, digest.frame, { encoding: "rgba" });
      assert.equal(digest.sha256, hash(preview.png), "Preview equals frame supplied to FFmpeg");
    }
    assert.ok(after.state.expressions!.length >= 10, "other requested entrances and inertia were retained");
    const doc = await readMotion(f.project);
    await changeMotion(f.project.root, { expectedRevision: doc.revision, request: "undo regression", action: "undo" });
    assert.deepEqual((await readMotion(f.project)).state, initial.state);
  } finally { stop(); await closeNativeRenderer(); await f.cleanup(); }
});
