import test from "node:test";
import assert from "node:assert/strict";
import { identityFixture, node } from "./identity-fixture.js";
import { objectRequirement, emptyParameters } from "./intent-fixture.js";
import {
  compileTasks,
  compileRequirement,
  validateRequirement,
  expandInheritance,
} from "../src/motion/intent/compiler.js";
import {
  intentTechnique,
  type IntentPlan,
  type IntentRequirement,
} from "../src/motion/intent/schema.js";
import {
  validateIntentPlan,
  semanticPlan,
} from "../src/motion/intent/planner.js";
import {
  inspectSemanticCoverage,
  SemanticCoverageError,
} from "../src/motion/intent/coverage.js";
import { applyOperations } from "../src/motion/operations.js";
import {
  assertIntentScope,
  requirementChecks,
  runIntentTasks,
} from "../src/motion/intent/execution.js";
import { agentContext } from "../src/harness/context.js";
import { harnessConfigSchema } from "../src/harness/config.js";
import {
  semanticBindings,
  techniques,
} from "../src/motion-library/techniques/registry.js";
import { capabilityCatalog } from "../src/motion-library/registry/capabilities.js";
import { logicalId } from "../src/motion/registry.js";
import { numericQA } from "../src/motion/qa/numeric.js";
import { motionQA } from "../src/motion/qa/render.js";
import { executeMotion } from "../src/motion/service.js";
import { registerProvider } from "../src/harness/providers/index.js";
import { readMotion, changeMotion } from "../src/motion/store.js";
async function fixture(duplicates = false) {
  const f = await identityFixture(3, (scenes) => {
    for (const [i, s] of scenes.entries()) {
      const qr = node("qr" + i, "куар", 20, 20),
        logo = node("logo" + i, "лого", 70, 20),
        image = node("image" + i, "image 1926988171", 120, 20),
        line = node("line" + i, "лента 1", 20, 80, 150, 20),
        line2 = node("second" + i, "лента 2", 20, 120, 150, 20);
      for (const n of [line, line2]) {
        n.type = "VECTOR";
        n.properties = {
          ...n.properties,
          fills: [],
          strokeWeight: 2,
          strokeAlign: "CENTER",
          strokes: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }],
          vectorPaths: [
            { data: "M0 0 C50 25 100 -25 150 0", windingRule: "NONZERO" },
          ],
        };
      }
      const text = node("text" + i, "Main text", 20, 50);
      text.type = "TEXT";
      text.text = {
        characters: "Mask",
        fontSize: 16,
        fontName: { family: "Arial", style: "Regular" },
      };
      s.children = [
        qr,
        logo,
        image,
        line,
        line2,
        text,
        ...(duplicates ? [node("duplicate" + i, "QR", 170, 20)] : []),
      ];
    }
  });
  f.state.settings = { ...f.state.settings, fps: 30, durationFrames: 270 };
  f.state.blocks.forEach((b, i) => {
    b.startFrame = i * 90;
    b.durationFrames = 90;
  });
  f.state.animations = [];
  f.state.expressions = [];
  f.state.objectTransitions = [];
  return f;
}
function planFor(r: IntentRequirement): IntentPlan {
  return {
    schemaVersion: "1.0.0",
    requirements: [r],
    coverage: [
      {
        sourceText: r.sourceText,
        requirementIds: [r.requirementId],
        classification: "executable",
        explanation: "synthetic regression input",
      },
    ],
    assumptions: [],
  };
}
function requirement(
  technique: IntentRequirement["techniques"][number],
  kind: IntentRequirement["kind"] = "objectAnimation",
) {
  const r = objectRequirement(
    "r",
    "s0",
    technique === "trimPath"
      ? "line0"
      : technique === "maskReveal"
        ? "text0"
        : "qr0",
    technique === "trimPath"
      ? "лента 1"
      : technique === "maskReveal"
        ? "Main text"
        : "куар",
    [technique],
    "fixture instruction",
  );
  r.kind = kind;
  r.target.logicalObjectId = logicalId(r.target.name!);
  if (technique === "objectStateTransition") r.parameters.toSceneId = "s1";
  return r;
}
test("P0 capability coverage: every advertised semantic technique CREATE→scope→validation→numeric evaluator", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(
      Object.keys(semanticBindings).sort(),
      [...intentTechnique.options].sort(),
    );
    for (const advertised of techniques) {
      assert.ok(
        advertised.id === "trimPaths" || advertised.id in semanticBindings,
      );
    }
    for (const technique of intentTechnique.options) {
      const r = requirement(technique),
        plan = planFor(r),
        state = structuredClone(f.state);
      if (technique === "inertialOvershoot")
        state.animations = [
          {
            animationId: "base",
            sceneId: "s0",
            targetId: "qr0",
            effect: "slideUp",
            parameters: { distance: 80, mode: "in" },
            startFrame: 0,
            durationFrames: 21,
            easing: "linear",
            enabled: true,
          },
        ];
      const task = compileTasks(f.project, plan)[0],
        ops = compileRequirement(f.project, state, plan, task).operations,
        next = applyOperations(state, ops, f.project);
      assert.doesNotThrow(
        () => assertIntentScope(f.project, state, next, plan, task),
        technique,
      );
      assert.ok(
        requirementChecks(next, r, plan, state).every(
          (c) => c.status === "PASSED",
        ),
        technique +
          ":" +
          JSON.stringify(requirementChecks(next, r, plan, state)),
      );
      assert.ok(
        numericQA(next).checks.every((c) => c.status !== "FAILED"),
        technique,
      );
      if (technique === "wiggle")
        assert.equal(next.expressions?.[0].type, "wiggle");
      if (["spring", "customCurve"].includes(technique))
        assert.equal(next.animations[0].effect, "property");
    }
    assert.ok(
      capabilityCatalog()
        .find((c) => c.id === "wiggle")
        ?.semanticTechniques.includes("wiggle"),
    );
  } finally {
    await f.cleanup();
  }
});
test("P0 edits preserve existing wiggle IDs and base tracks; easing edits preserve values and unrelated fade", async () => {
  const f = await fixture();
  try {
    for (const technique of ["wiggle", "spring", "customCurve"] as const) {
      const r = requirement(technique),
        p = planFor(r),
        baseline = applyOperations(
          f.state,
          compileRequirement(
            f.project,
            f.state,
            p,
            compileTasks(f.project, p)[0],
          ).operations,
          f.project,
        ),
        before = applyOperations(
          baseline,
          [
            {
              type: "addAnimation",
              animation: {
                animationId: "unrelated-fade",
                sceneId: "s0",
                targetId: "qr0",
                effect: "fadeIn",
                parameters: { from: 0, to: 1 },
                startFrame: 3,
                durationFrames: 15,
                easing: "easeOutCubic",
                enabled: true,
              },
            },
          ],
          f.project,
        );
      const edit = {
        ...r,
        kind: "editAnimation" as const,
        parameters: {
          ...r.parameters,
          ...(technique === "wiggle"
            ? { amplitudeFactor: 0.5 }
            : {
                easing:
                  technique === "spring"
                    ? {
                        type: "spring" as const,
                        parameters: { stiffness: 150, damping: 8, mass: 1 },
                      }
                    : {
                        type: "cubicBezier" as const,
                        parameters: { x1: 0.4, y1: 0, x2: 0.6, y2: 1 },
                      },
              }),
        },
        timing: { ...r.timing, relation: "unchanged" as const },
      };
      const ep = planFor(edit),
        task = compileTasks(f.project, ep)[0],
        after = applyOperations(
          before,
          compileRequirement(f.project, before, ep, task).operations,
          f.project,
        );
      assert.doesNotThrow(() =>
        assertIntentScope(f.project, before, after, ep, task),
      );
      assert.ok(
        requirementChecks(after, edit, ep, before).every(
          (c) => c.status === "PASSED",
        ),
      );
      assert.deepEqual(
        after.animations.find((a) => a.animationId === "unrelated-fade"),
        before.animations.find((a) => a.animationId === "unrelated-fade"),
      );
      if (technique === "wiggle") {
        assert.equal(
          after.expressions?.[0].expressionId,
          before.expressions?.[0].expressionId,
        );
        assert.equal(after.expressions?.[0].parameters.amplitude, 5);
        assert.deepEqual(after.animations, before.animations);
      } else {
        assert.equal(
          after.animations[0].animationId,
          before.animations[0].animationId,
        );
        assert.deepEqual(
          after.animations[0].parameters,
          before.animations[0].parameters,
        );
      }
    }
  } finally {
    await f.cleanup();
  }
});
test("P0 explicit Slide/Fade/Overshoot coverage rejects full-text deceit and audits only suspicious plans", async () => {
  const f = await fixture();
  try {
    for (const prompt of [
      "QR появляется снизу через Fade.",
      "QR снизу с фейдом и затухающими колебаниями.",
    ]) {
      const r = requirement("slideUp");
      r.sourceText = prompt;
      r.target.name = "QR";
      const bad = planFor(r);
      assert.throws(
        () => validateIntentPlan(f.project, prompt, bad),
        SemanticCoverageError,
      );
      const good = structuredClone(bad);
      good.requirements[0].techniques = prompt.includes("колеб")
        ? ["slideUp", "fadeIn", "inertialOvershoot"]
        : ["slideUp", "fadeIn"];
      let calls = 0,
        audits = 0;
      const provider = {
        interpret: async () => {
          calls++;
          return bad;
        },
        audit: async () => {
          audits++;
          return good;
        },
      };
      const repaired = await semanticPlan(
        f.project,
        prompt,
        {},
        provider,
        async () => {},
        { auditAlways: false },
      );
      assert.equal(calls, 1);
      assert.equal(audits, 1);
      assert.ok(repaired.requirements[0].techniques.includes("fadeIn"));
      calls = 0;
      audits = 0;
      await semanticPlan(
        f.project,
        prompt,
        {},
        {
          ...provider,
          interpret: async () => {
            calls++;
            return good;
          },
        },
        async () => {},
        { auditAlways: false },
      );
      assert.equal(calls, 1);
      assert.equal(audits, 0);
    }
  } finally {
    await f.cleanup();
  }
});
test("P0 logo inherits ALL character; scene timing, sequential trim, relative edit and missing target are checked", async () => {
  const f = await fixture();
  try {
    const prompt =
      "Сцена 2 начинается на 1 секунде. QR снизу через Fade с инерцией. Лого аналогично, но быстрее. Сцена 3 начинается на 3 секунде. Лента 1 прорисовывается. Когда она закончится, лента 2 аналогично.";
    const qr = objectRequirement(
        "qr",
        "s1",
        "qr1",
        "куар",
        ["slideUp", "fadeIn", "inertialOvershoot"],
        prompt,
      ),
      logo = objectRequirement("logo", "s1", "logo1", "лого", [], prompt);
    logo.parameters.durationFactor = 0.5;
    const first = objectRequirement(
        "line",
        "s2",
        "line2",
        "лента 1",
        ["trimPath"],
        prompt,
      ),
      second = objectRequirement(
        "second",
        "s2",
        "second2",
        "лента 2",
        [],
        prompt,
      );
    const timings = ["s1", "s2"].map((sceneId, i) => ({
      ...requirement("slideUp"),
      requirementId: "timing" + i,
      kind: "sceneTiming" as const,
      sceneId,
      target: { name: null, sourceNodeId: null, logicalObjectId: null },
      techniques: [],
      sourceText: prompt,
      timing: {
        startSeconds: i ? 3 : 1,
        relation: "sceneStart" as const,
        anchorRequirementId: null,
        delaySeconds: 0,
      },
    }));
    const p: IntentPlan = {
      ...planFor(qr),
      requirements: [...timings, qr, logo, first, second],
    };
    p.coverage[0].requirementIds = p.requirements.map((r) => r.requirementId);
    assert.throws(
      () => validateIntentPlan(f.project, prompt, p),
      /MISSING_SEQUENTIAL_DEPENDENCY/,
    );
    second.timing.relation = "afterRequirement";
    second.timing.anchorRequirementId = "line";
    const good = validateIntentPlan(f.project, prompt, p),
      expanded = expandInheritance(good);
    assert.deepEqual(
      expanded.requirements.find((r) => r.requirementId === "logo")?.techniques,
      qr.techniques,
    );
    assert.equal(
      expanded.requirements.find((r) => r.requirementId === "logo")?.parameters
        .durationFactor,
      0.5,
    );
    const missing = structuredClone(good);
    missing.requirements = missing.requirements.filter(
      (r) => r.kind !== "sceneTiming",
    );
    missing.coverage[0].requirementIds = missing.requirements.map(
      (r) => r.requirementId,
    );
    assert.throws(
      () => validateIntentPlan(f.project, prompt, missing),
      /MISSING_SCENE_TIMING/,
    );
    const relative = requirement("inertialOvershoot", "editAnimation");
    relative.sourceText = "Колебания QR вдвое слабее";
    assert.throws(
      () =>
        validateIntentPlan(f.project, relative.sourceText, planFor(relative)),
      /MISSING_RELATIVE_EDIT/,
    );
  } finally {
    await f.cleanup();
  }
});
test("P0 complete object index keeps QR aliases beside exact Image, includes multiple scenes, rejects ambiguity", async () => {
  const f = await fixture();
  try {
    const ctx = await agentContext(
      f.project,
      f.state,
      {
        request:
          "сцена 2 image 1926988171 и QR появляются снизу сцена 3 лого аналогично",
      },
      [],
      harnessConfigSchema.parse({}),
    );
    assert.ok(
      ctx.value.objectIndex.some(
        (o) => o.sceneId === "s1" && o.name === "куар",
      ),
    );
    assert.ok(
      ctx.value.objectIndex.some(
        (o) => o.sceneId === "s2" && o.name === "лого",
      ),
    );
    assert.ok(ctx.bytes < 60000);
    assert.ok(!JSON.stringify(ctx.value).includes("M0 0 C50"));
    const r = requirement("slideUp");
    r.sourceText = "QR снизу";
    r.target.sourceNodeId = null;
    r.target.logicalObjectId = null;
    r.target.name = "QR";
    assert.equal(
      validateIntentPlan(f.project, r.sourceText, planFor(r)).requirements[0]
        .target.sourceNodeId,
      "qr0",
    );
  } finally {
    await f.cleanup();
  }
  const d = await fixture(true);
  try {
    const r = requirement("slideUp");
    r.sourceText = "QR снизу";
    r.target.sourceNodeId = null;
    r.target.logicalObjectId = null;
    r.target.name = "QR";
    const p = validateIntentPlan(d.project, r.sourceText, planFor(r));
    assert.equal(p.requirements[0].unresolvedReason, "AMBIGUOUS_TARGET");
    assert.equal(p.requirements[0].target.sourceNodeId, null);
  } finally {
    await d.cleanup();
  }
});
test("P0 actual local renderer verifies wiggle/spring/customCurve created through semantic task execution", async () => {
  const f = await fixture();
  try {
    for (const technique of ["wiggle", "spring", "customCurve"] as const) {
      const r = requirement(technique),
        p = planFor(r);
      let state = f.state;
      const result = await runIntentTasks(f.project, state, p, {
        repair: async () => {
          throw new Error("Unexpected repair");
        },
        verify: async (task, next, before, attempt) =>
          motionQA(
            f.project,
            next,
            `motion/qa/p0-${technique}`,
            r.sourceText,
            before,
            task.targetReference,
          ),
        commit: async (_task, _plan, next) => {
          state = next;
          return next;
        },
        trace: async () => {},
      });
      assert.equal(
        result.reconciliation.status,
        "SUCCESS",
        technique + ":" + JSON.stringify(result.tasks.map((t) => t.error)),
      );
      assert.ok(result.tasks[0].repairHistory.length === 1);
    }
  } finally {
    await f.cleanup();
  }
});
test("P0 normal user execution via mock provider uses ONE call, persists new technique, runs genuine local QA", async () => {
  const f = await fixture();
  let calls = 0;
  const unregister = registerProvider("p0-fixture", () => ({
    id: "p0-fixture",
    mode: "mock",
    capabilities: () => ({
      structuredOutput: true,
      nativeToolCalling: false,
      cancellation: true,
      usage: true,
      nativeOutputTokenLimit: false,
    }),
    generate: async () => {
      calls++;
      const r = requirement("wiggle");
      r.sourceText = "Добавь QR wiggle";
      return {
        output: planFor(r),
        usage: { inputTokens: 100, outputTokens: 50 },
        estimatedCost: null,
        latencyMs: 1,
        diagnostics: [
          "synthetic provider; real local QA; not live provider E2E",
        ],
        toolCalls: [],
      };
    },
  }));
  try {
    let doc = await readMotion(f.project);
    doc = (
      await changeMotion(f.project.root, {
        expectedRevision: doc.revision,
        request: "seed fixture settings",
        operations: [
          { type: "setProjectSettings", settings: f.state.settings },
          { type: "setBlocks", blocks: f.state.blocks },
        ],
      })
    ).document;
    const result = await executeMotion(f.project, {
      mode: "create",
      request: "Добавь QR wiggle",
      settings: { provider: "p0-fixture", model: "" },
      expectedRevision: doc.revision,
      selectedSceneId: "s0",
      activeSceneId: "s0",
    });
    assert.equal(result.reconciliation?.status, "SUCCESS");
    assert.equal(calls, 1);
    assert.equal(
      (await readMotion(f.project)).state.expressions?.[0].type,
      "wiggle",
    );
  } finally {
    unregister();
    await f.cleanup();
  }
});

test("P0 provenance rejects a clause linked to a different object; также does not leak ribbon technique to discount", async () => {
  const f = await fixture();
  try {
    const qr = requirement("slideUp");
    qr.sourceText = "QR снизу с фейдом";
    qr.techniques = ["slideUp", "fadeIn"];
    const logo = {
      ...qr,
      requirementId: "logo",
      target: {
        name: "лого",
        sourceNodeId: "logo0",
        logicalObjectId: logicalId("лого"),
      },
    };
    const p = planFor(qr);
    p.requirements.push(logo);
    p.coverage[0].requirementIds = ["logo"];
    assert.throws(
      () => validateIntentPlan(f.project, qr.sourceText, p),
      /UNLINKED_CLAUSE_REQUIREMENT/,
    );
    const prompt =
      "Лента 1 прорисовывается. Также лого появляется снизу с фейдом.";
    const line = objectRequirement(
        "line",
        "s0",
        "line0",
        "лента 1",
        ["trimPath"],
        prompt,
      ),
      l = objectRequirement(
        "logo",
        "s0",
        "logo0",
        "лого",
        ["slideUp", "fadeIn"],
        prompt,
      );
    const good = planFor(line);
    good.requirements.push(l);
    good.coverage[0].requirementIds = ["line", "logo"];
    assert.equal(
      validateIntentPlan(f.project, prompt, good).requirements[1]
        .inheritFromRequirementId,
      null,
    );
  } finally {
    await f.cleanup();
  }
});
