import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  normalizeProviderOutput,
  compatibleSchema,
} from "../src/motion/provider.js";
import { intentPlanSchema } from "../src/motion/intent/schema.js";
import { objectRequirement } from "./intent-fixture.js";
import { identityFixture, node } from "./identity-fixture.js";
import {
  compileRequirement,
  compileTasks,
} from "../src/motion/intent/compiler.js";
import { applyOperations } from "../src/motion/operations.js";
import { evaluateMotion } from "../src/motion/engine.js";
const request =
  "пусть текст 1 и тарелка куар лого 1 лого 2 появляются через фейд - то есть добавь к ним еще анимацию фейда при появлении";
const ids = ["9:339", "9:337", "54:1522", "54:1585", "54:1588"];
const names = ["текст 1", "тарелка", "куар", "лого 1", "лого 2"];
const makePlan = () => ({
  schemaVersion: "1.0.0",
  requirements: ids.map((id, i) =>
    objectRequirement("r" + i, "s1", id, names[i], ["fadeIn"], request),
  ),
  coverage: [
    {
      sourceText: request,
      requirementIds: ids.map((_, i) => "r" + i),
      classification: "executable",
      explanation: "explicit targets",
    },
  ],
  assumptions: [],
});
test("provider optional-null round trip preserves nullability and rejects unknown enums", () => {
  const schema = z.toJSONSchema(intentPlanSchema, {
    io: "output",
    reused: "ref",
  });
  const wire = makePlan();
  for (const r of wire.requirements)
    Object.assign(r, {
      selector: null,
      expressionAction: null,
      expressionIds: null,
      selectionRequirementId: null,
      parameters: { ...r.parameters, relativeIntensity: null },
    });
  assert.equal(intentPlanSchema.safeParse(wire).success, false);
  const normalized = normalizeProviderOutput(wire, schema);
  assert.equal(intentPlanSchema.safeParse(normalized).success, true);
  assert.ok(JSON.stringify(compatibleSchema(schema)).includes('"null"'));
  Object.assign(wire.requirements[0], { expressionAction: "nonsense" });
  assert.equal(
    intentPlanSchema.safeParse(normalizeProviderOutput(wire, schema)).success,
    false,
  );
});
test("Fade composition follows five actual entrance intervals and preserves movement/inertia; repeat is stable", async () => {
  const f = await identityFixture(2, (scenes) => {
    scenes[1].children = ids.map((id, i) => node(id, names[i], i * 25, 10));
  });
  try {
    f.state.settings.fps = 30;
    f.state.settings.durationFrames = 90;
    f.state.blocks[0].startFrame = 0;
    f.state.blocks[0].durationFrames = 30;
    f.state.blocks[1].startFrame = 30;
    f.state.blocks[1].durationFrames = 60;
    f.state.animations = ids.map((targetId, i) => ({
      animationId: "base" + i,
      sceneId: "s1",
      targetId,
      startFrame: 30,
      durationFrames: 15,
      easing: "linear",
      effect: i === 0 ? "slideDown" : "slideUp",
      parameters: { distance: 40, mode: "in" },
      enabled: true,
    }));
    const original = structuredClone(f.state.animations);
    const plan = intentPlanSchema.parse(makePlan());
    let state = f.state;
    for (let repeat = 0; repeat < 2; repeat++)
      for (const task of compileTasks(f.project, plan))
        state = applyOperations(
          state,
          compileRequirement(f.project, state, plan, task).operations,
          f.project,
        );
    assert.deepEqual(
      state.animations.filter((a) => a.animationId.startsWith("base")),
      original,
    );
    const fades = state.animations.filter((a) => a.effect === "fadeIn");
    assert.equal(fades.length, 5);
    assert.ok(
      fades.every((a) => a.startFrame === 30 && a.durationFrames === 15),
    );
    for (const frame of [0, 30, 37, 45, 80]) {
      const v = evaluateMotion(state, frame).nodes[
        JSON.stringify(["s1", ids[0]])
      ];
      assert.equal(
        v.opacity,
        frame <= 30 ? 0 : frame >= 45 ? 1 : 1 - Math.pow(1 - 7 / 15, 3),
      );
      assert.ok(v.y !== undefined);
    }
  } finally {
    await f.cleanup();
  }
});
import { registerProvider } from "../src/harness/providers/index.js";
import { executeMotion } from "../src/motion/service.js";
import { changeMotion, readMotion } from "../src/motion/store.js";
import { recentSuccessfulActions } from "../src/motion/contextual-resolution.js";
test("adapter/parser/compiler/executor adds five Fades in one call after contextual inertia edit, preserving source tracks", async () => {
  const f = await identityFixture(2, (scenes) => {
    scenes[1].children = ids.map((id, i) => node(id, names[i], i * 25, 10));
  });
  let calls = 0;
  let contextBytes = 0;
  const stop = registerProvider("fade-contract-fixture", () => ({
    id: "fade-contract-fixture",
    mode: "mock",
    capabilities: () => ({
      structuredOutput: true,
      nativeToolCalling: false,
      cancellation: true,
      usage: false,
      nativeOutputTokenLimit: false,
    }),
    generate: async (req) => {
      calls++;
      contextBytes = Buffer.byteLength(req.messages[1].content);
      const text = JSON.parse(req.messages[1].content).userRequest;
      const wire = makePlan();
      if (text.includes("слабее")) {
        const r = objectRequirement(
          "weak",
          "s1",
          ids[0],
          names[0],
          ["inertialOvershoot"],
          text,
        );
        r.kind = "editAnimation";
        r.target = { sourceNodeId: null, logicalObjectId: null, name: null };
        r.sceneId = null;
        r.selector = {
          type: "recentSuccessfulTargets",
          effect: "inertialOvershoot",
        };
        r.parameters.amplitudeFactor = 0.5;
        r.timing.relation = "unchanged";
        return {
          output: {
            schemaVersion: "1.0.0",
            requirements: [r],
            coverage: [
              {
                sourceText: text,
                requirementIds: ["weak"],
                classification: "executable",
                explanation: "recent inertia group",
              },
            ],
            assumptions: [],
          },
          usage: null,
          estimatedCost: null,
          latencyMs: 0,
          diagnostics: ["mock"],
          toolCalls: [],
        };
      }
      wire.requirements.forEach((r) =>
        Object.assign(r, {
          selector: null,
          selectionRequirementId: null,
          expressionIds: null,
          expressionAction: null,
          parameters: { ...r.parameters, relativeIntensity: null },
        }),
      );
      return {
        output: wire,
        usage: null,
        estimatedCost: null,
        latencyMs: 0,
        diagnostics: ["deterministic wire fixture, not live LLM"],
        toolCalls: [],
      };
    },
  }));
  try {
    const d = await readMotion(f.project);
    f.state.settings.fps = 30;
    f.state.settings.durationFrames = 90;
    f.state.blocks[0].startFrame = 0;
    f.state.blocks[0].durationFrames = 30;
    f.state.blocks[1].startFrame = 30;
    f.state.blocks[1].durationFrames = 60;
    const bases = ids.map((targetId, i) => ({
      animationId: "base" + i,
      sceneId: "s1",
      targetId,
      startFrame: 30,
      durationFrames: 15,
      easing: "linear" as const,
      effect: i === 0 ? ("slideDown" as const) : ("slideUp" as const),
      parameters: { distance: 40, mode: "in" as const },
      enabled: true,
    }));
    const expressions = bases.map((a, i) => ({
      expressionId: "inertia" + i,
      sceneId: "s1",
      targetId: a.targetId,
      property: "y" as const,
      type: "inertialOvershoot" as const,
      sourceAnimationId: a.animationId,
      startFrame: 45,
      durationFrames: 36,
      enabled: true,
      parameters: {
        mode: "ae",
        amplitude: 0.125,
        frequency: 2.5,
        decay: 3,
        velocityLookbackFrames: 3,
      },
    }));
    const before = (
      await changeMotion(f.project.root, {
        expectedRevision: d.revision,
        request: "сделай колебания послабее",
        operations: [
          { type: "setProjectSettings", settings: f.state.settings },
          { type: "setBlocks", blocks: f.state.blocks },
          ...bases.map((animation) => ({
            type: "addAnimation" as const,
            animation,
          })),
          ...expressions.map((expression) => ({
            type: "setExpression" as const,
            expression,
          })),
        ],
      })
    ).document;
    const started = performance.now();
    const result = await executeMotion(f.project, {
      request,
      mode: "edit",
      selectedObjectId: ids[4],
      activeSceneId: "s1",
      expectedRevision: before.revision,
      settings: { provider: "fade-contract-fixture", model: "" },
    });
    assert.equal(
      result.reconciliation?.status,
      "SUCCESS",
      JSON.stringify(result),
    );
    assert.equal(calls, 1);
    const artifact = JSON.parse(
      await readFile(
        `${f.project.root}/motion/ai/${result.id}/semantic-interpret/contract-validation.json`,
        "utf8",
      ),
    );
    assert.equal(artifact.callIndex, 1);
    assert.equal(artifact.validation.status, "PASSED");
    assert.equal(artifact.rawOutput.requirements[0].expressionAction, null);
    assert.equal(
      "expressionAction" in artifact.normalizedOutput.requirements[0],
      false,
    );
    assert.equal(artifact.projectRevision, before.revision);
    assert.equal(artifact.providerSchemaHash.length, 64);
    const after = await readMotion(f.project);
    assert.deepEqual(after.state.expressions, before.state.expressions);
    assert.deepEqual(
      after.state.animations.filter((a) => a.animationId.startsWith("base")),
      before.state.animations,
    );
    assert.equal(
      after.state.animations.filter((a) => a.effect === "fadeIn").length,
      5,
    );
    assert.ok(
      after.state.animations
        .filter((a) => a.effect === "fadeIn")
        .every((a) => a.startFrame === 30 && a.durationFrames === 15),
    );
    assert.equal(recentSuccessfulActions(after)[0].expressionIds.length, 5);
    const weaker = await executeMotion(f.project, {
      request: "Сделай колебания слабее.",
      mode: "edit",
      expectedRevision: after.revision,
      settings: { provider: "fade-contract-fixture", model: "" },
    });
    assert.equal(weaker.reconciliation?.status, "SUCCESS");
    const weakState = await readMotion(f.project);
    assert.ok(
      weakState.state.expressions?.every(
        (e) => e.parameters.amplitude === 0.0625,
      ),
    );
    assert.deepEqual(weakState.state.animations, after.state.animations);
    const again = await executeMotion(f.project, {
      request,
      mode: "edit",
      expectedRevision: weakState.revision,
      settings: { provider: "fade-contract-fixture", model: "" },
    });
    assert.equal(again.reconciliation?.status, "SUCCESS");
    const final = await readMotion(f.project);
    assert.equal(
      final.state.animations.filter((a) => a.effect === "fadeIn").length,
      5,
    );
    assert.deepEqual(final.state.expressions, weakState.state.expressions);
    assert.equal(calls, 3);
    console.log(
      JSON.stringify({
        fixture: "fade wire E2E",
        calls,
        contextBytes,
        latencyMs: performance.now() - started,
        tokens: null,
        cost: null,
      }),
    );
  } finally {
    stop();
    await f.cleanup();
  }
});
test("Fade refuses overlapping opacity tracks, preserves exit fade and supports scene fallback", async () => {
  const f = await identityFixture(2, (scenes) => {
    scenes[1].children = ids.map((id, i) => node(id, names[i]));
  });
  try {
    f.state.settings.fps = 30;
    f.state.settings.durationFrames = 90;
    f.state.blocks[0].durationFrames = 30;
    f.state.blocks[1].startFrame = 30;
    f.state.blocks[1].durationFrames = 60;
    const plan = intentPlanSchema.parse(makePlan()),
      task = compileTasks(f.project, plan)[0];
    const base = {
      animationId: "exit",
      sceneId: "s1",
      targetId: ids[0],
      startFrame: 75,
      durationFrames: 15,
      easing: "linear" as const,
      effect: "fadeOut" as const,
      parameters: { from: 1, to: 0 },
      enabled: true,
    };
    f.state.animations = [base];
    const ops = compileRequirement(f.project, f.state, plan, task).operations;
    const state = applyOperations(f.state, ops, f.project);
    assert.deepEqual(
      state.animations.find((a) => a.animationId === "exit"),
      base,
    );
    assert.equal(
      state.animations.find((a) => a.effect === "fadeIn")?.startFrame,
      30,
    );
    f.state.animations = [{ ...base, startFrame: 30 }];
    assert.throws(
      () => compileRequirement(f.project, f.state, plan, task),
      /OPACITY_ENTRANCE_CONFLICT/,
    );
  } finally {
    await f.cleanup();
  }
});
test("invalid provider enum commits zero changes and creates no successful action", async () => {
  const f = await identityFixture(2, (scenes) => {
    scenes[1].children = ids.map((id, i) => node(id, names[i]));
  });
  let calls = 0;
  const stop = registerProvider("fade-invalid-fixture", () => ({
    id: "fade-invalid-fixture",
    mode: "mock",
    capabilities: () => ({
      structuredOutput: true,
      nativeToolCalling: false,
      cancellation: true,
      usage: false,
      nativeOutputTokenLimit: false,
    }),
    generate: async () => {
      calls++;
      const output = makePlan();
      Object.assign(output.requirements[0], { expressionAction: "weaker" });
      return {
        output,
        usage: null,
        estimatedCost: null,
        latencyMs: 0,
        diagnostics: [],
        toolCalls: [],
      };
    },
  }));
  try {
    const before = await readMotion(f.project);
    await assert.rejects(
      () =>
        executeMotion(
          f.project,
          {
            request,
            mode: "edit",
            expectedRevision: before.revision,
            settings: { provider: "fade-invalid-fixture", model: "" },
          },
          () => {},
          { config: { maxLLMCalls: 1, maxRepairAttempts: 0 } },
        ),
      /INVALID_OUTPUT|LLM_CALL_BUDGET/,
    );
    const after = await readMotion(f.project);
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.state, before.state);
    assert.deepEqual(
      recentSuccessfulActions(after),
      recentSuccessfulActions(before),
    );
    assert.equal(calls, 1);
  } finally {
    stop();
    await f.cleanup();
  }
});
