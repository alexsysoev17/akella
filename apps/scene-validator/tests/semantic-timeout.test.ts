import test from "node:test";
import assert from "node:assert/strict";
import type { SourceNode } from "../src/motion/registry.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { intentFixture } from "./intent-fixture.js";
import {
  semanticPlan,
  validateIntentPlan,
  semanticContext,
} from "../src/motion/intent/planner.js";
import { SemanticCoverageError } from "../src/motion/intent/coverage.js";
import { type IntentPlan } from "../src/motion/intent/schema.js";
import { HarnessRun, readRuns } from "../src/harness/runtime.js";
import {
  registerProvider,
  type ProviderAdapter,
  type ProviderRequest,
} from "../src/harness/providers/index.js";
import { executeMotion } from "../src/motion/service.js";
import { readMotion, changeMotion } from "../src/motion/store.js";
import { agentContext } from "../src/harness/context.js";
import { harnessConfigSchema } from "../src/harness/config.js";
import { inspectorRun } from "../src/harness/inspector.js";
const replay = JSON.parse(
  await readFile(
    new URL("./fixtures/semantic-timeout-plans.json", import.meta.url),
    "utf8",
  ),
) as { request: string; plans: IntentPlan[] };
async function fixture() {
  const f = await intentFixture();
  f.state.settings = { ...f.state.settings, fps: 30, durationFrames: 270 };
  f.state.blocks.forEach((b, i) => {
    b.startFrame = i * 90;
    b.durationFrames = 90;
  });
  const scenes = f.project.inspection.document.scenes;
  for (const r of replay.plans[0].requirements) {
    const n = scenes
      .flatMap((s) => s.children as SourceNode[])
      .find((n) => n.figmaNodeId === r.target.sourceNodeId);
    if (n) n.name = r.target.name!;
  }
  return f;
}
test("timeout replay: both saved ten-requirement contracts pass; postfix Ribbon2 never leaks into Discount; real missing Fade still fails", async () => {
  const f = await fixture();
  try {
    for (const p of replay.plans) {
      let calls = 0;
      const plan = await semanticPlan(
        f.project,
        replay.request,
        { motion: f.state },
        {
          interpret: async () => {
            calls++;
            return structuredClone(p);
          },
          audit: async () => {
            throw new Error("unnecessary audit");
          },
        },
        async () => {},
        { auditAlways: false },
      );
      assert.equal(calls, 1);
      assert.equal(plan.requirements.length, 10);
      assert.equal(
        plan.requirements.find((r) => r.requirementId === "r8")!.timing
          .anchorRequirementId,
        "r7",
      );
    }
    const p = structuredClone(replay.plans[0]);
    const req = replay.request.replace(
      "куар появляются снизу",
      "куар появляются снизу через Fade",
    );
    for (const r of p.requirements)
      r.sourceText = r.sourceText.replace(
        "куар появляются снизу",
        "куар появляются снизу через Fade",
      );
    for (const c of p.coverage)
      c.sourceText = c.sourceText.replace(
        "куар появляются снизу",
        "куар появляются снизу через Fade",
      );
    assert.throws(
      () => validateIntentPlan(f.project, req, p, 30),
      SemanticCoverageError,
    );
    const noSequence = structuredClone(replay.plans[0]);
    noSequence.requirements.find((r) => r.requirementId === "r8")!.timing = {
      startSeconds: null,
      relation: "sceneStart",
      anchorRequirementId: null,
      delaySeconds: 0,
    };
    assert.throws(
      () => validateIntentPlan(f.project, replay.request, noSequence, 30),
      /MISSING_SEQUENTIAL_DEPENDENCY/,
    );
    const wrong = structuredClone(replay.plans[0]);
    wrong.requirements[0].timing.startSeconds = 2;
    assert.throws(
      () => validateIntentPlan(f.project, replay.request, wrong, 30),
      /MISSING_SCENE_TIMING/,
    );
    const at60 = structuredClone(replay.plans[0]);
    at60.requirements
      .filter((r) => r.kind === "sceneTiming")
      .forEach((r) => (r.timing.startSeconds! /= 2));
    assert.equal(
      validateIntentPlan(f.project, replay.request, at60, 60).requirements
        .length,
      10,
    );
  } finally {
    await f.cleanup();
  }
});
test("persistent coverage failure gets exactly one precise audit, no third full-context interpret; diagnostics distinguish rejected JSON", async () => {
  const f = await fixture();
  try {
    const bad = structuredClone(replay.plans[0]);
    bad.requirements.find((r) => r.requirementId === "r9")!.techniques = [
      "trimPath",
    ];
    let interpret = 0,
      audit = 0;
    const events: { stage: string; value: unknown }[] = [];
    await assert.rejects(
      semanticPlan(
        f.project,
        replay.request,
        {},
        {
          interpret: async () => {
            interpret++;
            return bad;
          },
          audit: async (ctx) => {
            audit++;
            assert.ok((ctx as { coverageFeedback: unknown }).coverageFeedback);
            return bad;
          },
        },
        async (stage, value) => {
          events.push({ stage, value });
        },
        { auditAlways: false, maxAttempts: 3 },
      ),
      SemanticCoverageError,
    );
    assert.equal(interpret, 1);
    assert.equal(audit, 1);
    assert.ok(
      events.some(
        (e) =>
          e.stage.startsWith("semantic-retry-result") &&
          (e.value as { planChanged: boolean }).planChanged === false,
      ),
    );
  } finally {
    await f.cleanup();
  }
});
function adapter(
  action: (r: ProviderRequest) => Promise<unknown>,
): ProviderAdapter {
  return {
    id: "timeout-mock",
    mode: "mock",
    capabilities: () => ({
      structuredOutput: true,
      nativeToolCalling: false,
      cancellation: true,
      usage: false,
      nativeOutputTokenLimit: false,
    }),
    generate: async (r) => ({
      output: await action(r),
      usage: null,
      estimatedCost: null,
      latencyMs: 1,
      diagnostics: ["mock provider, not live E2E"],
      toolCalls: [],
    }),
  };
}
test("preflight refuses a call without sufficient remaining budget before adapter invocation; timeout cannot mutate motion state", async () => {
  const f = await fixture();
  const run = await HarnessRun.start(
    f.project,
    randomUUID(),
    "synthetic",
    "timeout-mock",
    "",
    undefined,
    {
      maxDurationMs: 2000,
      semanticPlanningTimeoutMs: 1000,
      minimumRetryBudgetMs: 500,
      executionReserveMs: 0,
    },
  );
  try {
    const before = await readMotion(f.project);
    run.calls.push({
      provider: "timeout-mock",
      mode: "mock",
      model: "",
      latencyMs: 800,
      usage: null,
      cost: null,
      status: "SUCCESS",
    });
    run.events.push({
      stage: "synthetic-budget-fixture",
      at: new Date().toISOString(),
      durationMs: 0,
      data: {},
    });
    let invoked = false;
    const req: ProviderRequest = {
      purpose: "semantic-repair",
      messages: [{ role: "user", content: "synthetic" }],
      responseSchema: {},
      timeoutMs: 1000,
      maxOutputTokens: 100,
    }; // insufficient phase time after an observed slow call
    await new Promise((r) => setTimeout(r, 220));
    await assert.rejects(
      run.invoke(
        adapter(async () => {
          invoked = true;
          return {};
        }),
        req,
      ),
      /SEMANTIC_TIME_BUDGET/,
    );
    assert.equal(invoked, false);
    assert.deepEqual(await readMotion(f.project), before);
    assert.ok(run.events.some((e) => e.stage === "provider-call-skipped"));
  } finally {
    await run.finish("FAILED");
    await f.cleanup();
  }
});
test("primary workflow replay: one mock call, all ten requirements, local real QA, correct frames/directions/dependency and no extra effects", async () => {
  const f = await fixture();
  let calls = 0;
  const unregister = registerProvider("timeout-mock", () =>
    adapter(async () => {
      calls++;
      return structuredClone(replay.plans[0]);
    }),
  );
  try {
    const d = await readMotion(f.project);
    await changeMotion(f.project.root, {
      expectedRevision: d.revision,
      request: "synthetic initial state",
      operations: [
        { type: "setProjectSettings", settings: f.state.settings },
        { type: "setBlocks", blocks: f.state.blocks },
      ],
    });
    const result = await executeMotion(f.project, {
      mode: "create",
      request: replay.request,
      activeSceneId: "s1",
      settings: { provider: "timeout-mock", model: "" },
      expectedRevision: (await readMotion(f.project)).revision,
    });
    assert.equal(result.reconciliation?.status, "SUCCESS");
    assert.equal(calls, 1);
    const doc = await readMotion(f.project);
    assert.equal(
      doc.state.blocks.find((b) => b.sceneId === "s1")!.startFrame,
      30,
    );
    assert.equal(
      doc.state.blocks.find((b) => b.sceneId === "s2")!.startFrame,
      90,
    );
    for (const [id, effect] of Object.entries({
      text: "slideDown",
      logo: "slideDown",
      image: "slideUp",
      qr: "slideUp",
      ribbon1: "trimPath",
      ribbon2: "trimPath",
      discount: "slideDown",
      shape: "slideDown",
    })) {
      assert.ok(
        doc.state.animations.some(
          (a) => a.targetId === id && a.effect === effect,
        ),
      );
    }
    const first = doc.state.animations.find((a) => a.targetId === "ribbon1")!,
      second = doc.state.animations.find((a) => a.targetId === "ribbon2")!;
    assert.equal(second.startFrame, first.startFrame + first.durationFrames);
    assert.equal(doc.state.expressions?.length ?? 0, 0);
    assert.ok(!doc.state.animations.some((a) => a.effect.startsWith("fade")));
    const view = await inspectorRun(f.project.root, result.id!);
    assert.ok(view.semanticDiagnostics);
  } finally {
    unregister();
    await f.cleanup();
  }
});
test("semantic context removes duplicated executable schemas and geometry but keeps complete index, current motion and identities", async () => {
  const f = await fixture();
  try {
    const full = (
      await agentContext(
        f.project,
        f.state,
        { request: replay.request, activeSceneId: "s1" },
        [],
        harnessConfigSchema.parse({}),
      )
    ).value;
    const compact = semanticContext(full) as typeof full;
    assert.deepEqual(compact.objectIndex, full.objectIndex);
    assert.deepEqual(compact.motion, full.motion);
    assert.ok(JSON.stringify(compact).length < JSON.stringify(full).length);
    assert.ok(
      !JSON.stringify(compact.motionKnowledge.capabilities).includes(
        "parameterSchema",
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test("provider timeout preserves state and persisted diagnostic history instead of a generic unexplained abort", async () => {
  const f = await fixture();
  const stop = registerProvider("timeout-mock", () =>
    adapter(
      async (req) =>
        new Promise((_, reject) =>
          req.signal!.addEventListener(
            "abort",
            () => reject(req.signal!.reason),
            { once: true },
          ),
        ),
    ),
  );
  try {
    await mkdir(f.project.root + "/motion/harness", { recursive: true });
    await writeFile(
      f.project.root + "/motion/harness/config.json",
      JSON.stringify({
        maxDurationMs: 2000,
        semanticPlanningTimeoutMs: 1000,
        providerTimeoutMs: 1000,
      }),
    );
    const before = await readMotion(f.project);
    await assert.rejects(
      executeMotion(f.project, {
        mode: "create",
        request: replay.request,
        settings: { provider: "timeout-mock", model: "" },
        expectedRevision: before.revision,
      }),
      /timeout|aborted/i,
    );
    assert.deepEqual(await readMotion(f.project), before);
    const runs = await readRuns(f.project.root);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "TIMEOUT");
    const view = await inspectorRun(f.project.root, String(runs[0].runId));
    assert.ok(
      JSON.stringify(view.semanticDiagnostics).includes('"category":"TIMEOUT"'),
    );
  } finally {
    stop();
    await f.cleanup();
  }
});
