import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { evalFixture } from "./harness-fixtures.js";
import { readMotion } from "../apps/scene-validator/src/motion/store.js";
import { executeMotion } from "../apps/scene-validator/src/motion/service.js";
import { readRuns } from "../apps/scene-validator/src/harness/runtime.js";
const out = "artifacts/core-inertia";
await mkdir(out, { recursive: true });
const results = [];
for (const prompt of [
  "Сделай инерцию после движения.",
  "Добавь затухающие колебания.",
  "Пусть объект немного покачается после остановки.",
]) {
  const f = await evalFixture({
    evalId: "CORE_INERTIA",
    prompt,
    fixture: "motion",
    seed: "linear-slide",
    target: "qr",
    scene: "s0",
    expectedCapabilities: ["inertialOvershoot"],
    checks: [],
  });
  try {
    const before = await readMotion(f.project);
    const input = {
      mode: "create",
      request: prompt,
      selectedObjectId: "qr",
      selectedSceneId: "s0",
      activeSceneId: "s0",
      settings: { provider: "codex-sdk", model: "" },
      expectedRevision: before.revision,
    };
    const result = await executeMotion(f.project, input);
    const after = await readMotion(f.project);
    const effects =
      after.state.expressions?.filter(
        (e) => e.type === "inertialOvershoot" && e.targetId === "qr",
      ) ?? [];
    assert.equal(result.reconciliation?.status, "SUCCESS");
    assert.ok(effects.length);
    assert.ok(
      effects.every(
        (e) => e.type === "inertialOvershoot" && e.parameters.mode === "ae",
      ),
    );
    assert.deepEqual(before.state.animations, after.state.animations);
    let edit: unknown = null;
    if (results.length === 0) {
      const edited = await executeMotion(f.project, {
        ...input,
        mode: "edit",
        request: "Сделай колебания вдвое слабее.",
        expectedRevision: after.revision,
      });
      const final = await readMotion(f.project);
      assert.equal(edited.reconciliation?.status, "SUCCESS");
      assert.deepEqual(final.state.animations, after.state.animations);
      for (const e of effects) {
        const changed = final.state.expressions!.find(
          (p) => p.expressionId === e.expressionId,
        )!;
        assert.equal(changed.parameters.amplitude, e.parameters.amplitude / 2);
      }
      edit = { result: edited, baseUnchanged: true };
    }
    results.push({
      prompt,
      provider: "real codex-sdk",
      fixture:
        "artificial scene with pre-existing linear movement; no AE terminology",
      result,
      modernAlgorithm: true,
      baseUnchanged: true,
      edit,
      runs: await readRuns(f.project.root),
    });
    await writeFile(
      out + "/live-provider.json",
      JSON.stringify({ results }, null, 2),
    );
    console.log(prompt, "PASSED");
  } finally {
    await f.cleanup();
  }
}
