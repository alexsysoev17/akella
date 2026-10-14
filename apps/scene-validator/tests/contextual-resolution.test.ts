import test from "node:test";
import assert from "node:assert/strict";
import { identityFixture, node } from "./identity-fixture.js";
import { objectRequirement } from "./intent-fixture.js";
import { recentSuccessfulActions } from "../src/motion/contextual-resolution.js";
import { readMotion, changeMotion } from "../src/motion/store.js";
import {
  validateIntentPlan,
  semanticContext,
} from "../src/motion/intent/planner.js";
import {
  compileTasks,
  compileRequirement,
} from "../src/motion/intent/compiler.js";
import { applyOperations } from "../src/motion/operations.js";
import { evaluateMotion } from "../src/motion/engine.js";
import { executeMotion } from "../src/motion/service.js";
import { registerProvider } from "../src/harness/providers/index.js";
import {
  projectDiagnosticBundle,
  inspectorRun,
} from "../src/harness/inspector.js";
import JSZip from "jszip";
import type {
  IntentPlan,
  IntentRequirement,
} from "../src/motion/intent/schema.js";
import type { Expression } from "../src/motion-library/expressions/registry.js";
async function fixture() {
  const f = await identityFixture(2, (s) => {
    s.forEach((scene, index) => {
      scene.children = Array.from({ length: 3 }, (_, i) =>
        node(
          "n" + (index * 3 + i),
          "Object " + (index * 3 + i),
          15 + i * 50,
          45,
        ),
      );
    });
  });
  f.state.settings.fps = 30;
  f.state.settings.durationFrames = 120;
  f.state.blocks.forEach((b, i) => {
    b.startFrame = i * 60;
    b.durationFrames = 60;
  });
  f.state.animations = Array.from({ length: 6 }, (_, i) => ({
    animationId: "a" + i,
    sceneId: "s" + Math.floor(i / 3),
    targetId: "n" + i,
    startFrame: Math.floor(i / 3) * 60,
    durationFrames: 15,
    easing: "linear",
    enabled: true,
    effect: "slideUp",
    parameters: { distance: 80, mode: "in" },
  }));
  const expressions: Expression[] = f.state.animations.map((a, i) => ({
    expressionId: "e" + i,
    sceneId: a.sceneId,
    targetId: a.targetId,
    property: "y",
    type: "inertialOvershoot",
    sourceAnimationId: a.animationId,
    startFrame: a.startFrame + 15,
    durationFrames: 36,
    enabled: true,
    parameters: {
      mode: "ae",
      amplitude: 0.15 + i * 0.02,
      frequency: 2.5,
      decay: 3,
      velocityLookbackFrames: 3,
    },
  }));
  let d = await readMotion(f.project);
  d = (
    await changeMotion(f.project.root, {
      expectedRevision: d.revision,
      request: "old group",
      operations: [
        { type: "setProjectSettings", settings: f.state.settings },
        { type: "setBlocks", blocks: f.state.blocks },
        ...f.state.animations.map((animation) => ({
          type: "addAnimation" as const,
          animation,
        })),
        ...expressions.slice(4).map((expression) => ({
          type: "setExpression" as const,
          expression,
        })),
      ],
    })
  ).document;
  d = (
    await changeMotion(f.project.root, {
      expectedRevision: d.revision,
      request:
        "[12345678-1234-1234-1234-123456789abc/task_a] Add inertia to four",
      operations: expressions
        .slice(0, 4)
        .map((expression) => ({ type: "setExpression" as const, expression })),
    })
  ).document;
  return { ...f, doc: d };
}
function plan(
  text: string,
  selector?: IntentRequirement["selector"],
): IntentPlan {
  const r = objectRequirement(
    "group",
    "s0",
    "unused",
    "unused",
    ["inertialOvershoot"],
    text,
  );
  r.kind = "unsupported";
  r.sceneId = null;
  r.target = { sourceNodeId: null, logicalObjectId: null, name: null };
  r.parameters.amplitudeFactor = 0.5;
  r.timing.relation = "unchanged";
  r.selector = selector;
  r.unresolvedReason = "TARGET_UNRESOLVED";
  return {
    schemaVersion: "1.0.0",
    requirements: [r],
    coverage: [
      {
        sourceText: text,
        requirementIds: ["group"],
        classification: "unsupported",
        explanation: "mock semantic group",
      },
    ],
    assumptions: [],
  };
}
function resolve(
  f: Awaited<ReturnType<typeof fixture>>,
  p: IntentPlan,
  extra: Record<string, unknown> = {},
) {
  const events: unknown[] = [];
  const value = validateIntentPlan(
    f.project,
    p.requirements[0].sourceText,
    p,
    30,
    {
      state: f.doc.state,
      recentActions: recentSuccessfulActions(f.doc),
      projectRevision: f.doc.revision,
      onResolution: (e) => events.push(e),
      ...extra,
    },
  );
  return { value, events };
}
function apply(f: Awaited<ReturnType<typeof fixture>>, p: IntentPlan) {
  let state = f.doc.state;
  for (const t of compileTasks(f.project, p))
    state = applyOperations(
      state,
      compileRequirement(f.project, state, p, t).operations,
      f.project,
    );
  return state;
}
test("implicit recent four and explicit all six are different; individual amplitudes, IDs and numeric motion preserved", async () => {
  const f = await fixture();
  try {
    const implicit = resolve(f, plan("Сделай колебания послабее."));
    assert.equal(implicit.value.requirements.length, 4);
    assert.ok(
      JSON.stringify(implicit.events).includes(
        "12345678-1234-1234-1234-123456789abc",
      ),
    );
    const state = apply(f, implicit.value);
    for (let i = 0; i < 6; i++)
      assert.equal(
        state.expressions![i].parameters.amplitude,
        f.doc.state.expressions![i].parameters.amplitude *
          (Number(f.doc.state.expressions![i].targetId.slice(1)) < 4 ? 0.5 : 1),
      );
    assert.deepEqual(state.animations, f.doc.state.animations);
    const a = evaluateMotion(f.doc.state, 20),
      b = evaluateMotion(state, 20);
    assert.ok(
      Math.abs(
        b.nodes[JSON.stringify(["s0", "n0"])].y! -
          a.nodes[JSON.stringify(["s0", "n0"])].y! * 0.5,
      ) < 1e-9,
    );
    const all = resolve(
      f,
      plan("У всех объектов с инерцией сделай колебания слабее.", {
        type: "byExistingEffect",
        effect: "inertialOvershoot",
      }),
    );
    assert.equal(all.value.requirements.length, 6);
    const scopeReconciled = resolve(
      f,
      plan("У всех объектов с инерцией сделай колебания слабее.", {
        type: "recentSuccessfulTargets",
        effect: "inertialOvershoot",
      }),
    );
    assert.equal(scopeReconciled.value.requirements.length, 6);
    const wrong = resolve(
      f,
      plan("Сделай колебания послабее.", {
        type: "byExistingEffect",
        effect: "inertialOvershoot",
      }),
    );
    assert.equal(
      wrong.value.requirements[0].unresolvedReason,
      "SELECTOR_SCOPE_NOT_AUTHORIZED",
    );
  } finally {
    await f.cleanup();
  }
});
test("scene and selection scopes; no matching effects; stale/deleted references cannot recreate anything", async () => {
  const f = await fixture();
  try {
    assert.equal(
      resolve(
        f,
        plan("Во второй сцене сделай колебания слабее.", {
          type: "byScene",
          sceneId: "s1",
          effect: "inertialOvershoot",
        }),
      ).value.requirements.length,
      3,
    );
    const selected = resolve(
      f,
      plan("У выделенных объектов уменьши инерцию.", {
        type: "currentSelection",
        effect: "inertialOvershoot",
      }),
      { selectedObjectIds: ["n1", "n4"] },
    );
    assert.deepEqual(
      selected.value.requirements.map((r) => r.target.sourceNodeId).sort(),
      ["n1", "n4"],
    );
    f.doc = (
      await changeMotion(f.project.root, {
        expectedRevision: f.doc.revision,
        request: "delete one",
        operations: [{ type: "removeExpression", expressionId: "e1" }],
      })
    ).document;
    const next = resolve(f, plan("Сделай их слабее."));
    assert.equal(next.value.requirements.length, 3);
    assert.ok(
      !next.value.requirements.some((r) => r.expressionIds?.includes("e1")),
    );
    const removed = resolve(
      f,
      plan("У выделенных объектов убери инерцию.", {
        type: "currentSelection",
        effect: "inertialOvershoot",
      }),
      { selectedObjectId: "n0" },
    );
    removed.value.requirements[0].expressionAction = "remove";
    assert.ok(
      !apply(f, removed.value).expressions?.some(
        (e) => e.expressionId === "e0",
      ),
    );
    f.doc.state.expressions = [];
    assert.equal(
      resolve(
        f,
        plan("У всех объектов с инерцией уменьши амплитуду.", {
          type: "byExistingEffect",
          effect: "inertialOvershoot",
        }),
      ).value.requirements[0].unresolvedReason,
      "NO_MATCHING_EXISTING_EFFECTS",
    );
  } finally {
    await f.cleanup();
  }
});
test("absence of committed referent is ambiguous; undo/redo and project switch read effective current history", async () => {
  const f = await fixture();
  try {
    assert.equal(
      resolve(f, plan("Сделай колебания послабее."), { recentActions: [] })
        .value.requirements[0].unresolvedReason,
      "AMBIGUOUS_CONTEXTUAL_REFERENCE",
    );
    f.doc = (
      await changeMotion(f.project.root, {
        expectedRevision: f.doc.revision,
        request: "undo",
        action: "undo",
      })
    ).document;
    assert.equal(f.doc.state.expressions!.length, 2);
    assert.ok(
      !recentSuccessfulActions(f.doc).some(
        (a) => a.actionId === "12345678-1234-1234-1234-123456789abc",
      ),
    );
    f.doc = (
      await changeMotion(f.project.root, {
        expectedRevision: f.doc.revision,
        request: "redo",
        action: "redo",
      })
    ).document;
    assert.equal(
      resolve(f, plan("Сделай их слабее.")).value.requirements.length,
      4,
    );
    const other = await fixture();
    try {
      other.doc.history = [];
      other.doc.cursor = 0;
      assert.equal(
        resolve(other, plan("Сделай колебания послабее.")).value.requirements[0]
          .unresolvedReason,
        "AMBIGUOUS_CONTEXTUAL_REFERENCE",
      );
    } finally {
      await other.cleanup();
    }
    await assert.rejects(
      () =>
        changeMotion(f.project.root, {
          expectedRevision: "old-revision",
          request: "stale",
          operations: [{ type: "removeExpression", expressionId: "e0" }],
        }),
      /изменилась/,
    );
  } finally {
    await f.cleanup();
  }
});
test("multi-turn production selector execution: one mock call per turn, real selective QA, diagnostic ZIP, no unrelated changes", async () => {
  const f = await fixture();
  let calls = 0;
  const stop = registerProvider("context-mock", () => ({
    id: "context-mock",
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
      const text = JSON.parse(req.messages[1].content).userRequest;
      return {
        output: plan(
          text,
          text.includes("всех")
            ? { type: "byExistingEffect", effect: "inertialOvershoot" }
            : { type: "recentSuccessfulTargets", effect: "inertialOvershoot" },
        ),
        usage: null,
        estimatedCost: null,
        latencyMs: 0,
        diagnostics: ["mock, not live provider E2E"],
        toolCalls: [],
      };
    },
  }));
  try {
    let result: Awaited<ReturnType<typeof executeMotion>> | undefined;
    for (const text of [
      "Сделай колебания послабее.",
      "Ещё слабее.",
      "У всех объектов с инерцией сделай колебания слабее.",
    ]) {
      const before = await readMotion(f.project);
      result = await executeMotion(f.project, {
        mode: "edit",
        request: text,
        expectedRevision: before.revision,
        settings: { provider: "context-mock", model: "" },
      });
      assert.equal(
        result.reconciliation?.status,
        "SUCCESS",
        JSON.stringify(result),
      );
      assert.equal(result.reconciliation?.userIntentCount, 1);
      assert.equal(
        result.reconciliation?.selectedObjectCount,
        text.includes("всех") ? 6 : 4,
      );
      const after = await readMotion(f.project);
      assert.deepEqual(after.state.animations, before.state.animations);
      for (let i = 0; i < 6; i++)
        assert.equal(
          after.state.expressions![i].parameters.amplitude,
          before.state.expressions![i].parameters.amplitude *
            (text.includes("всех") ||
            Number(before.state.expressions![i].targetId.slice(1)) < 4
              ? 0.5
              : 1),
        );
    }
    assert.equal(calls, 3);
    const view = await inspectorRun(f.project.root, result!.id);
    assert.ok(
      JSON.stringify(view.targetResolution).includes(
        "CONTEXTUAL_TARGET_RESOLUTION",
      ),
    );
    const zip = await JSZip.loadAsync(
      await projectDiagnosticBundle(f.project.root, result!.id),
    );
    assert.ok(zip.file("manifest.json"));
    assert.ok(zip.file("recent-committed-actions.json"));
    assert.ok(!Object.keys(zip.files).some((n) => /\.(svg|png|mp4)$/.test(n)));
    const content = await zip.file("run-trace.json")!.async("string");
    assert.ok(!content.includes(f.root));
    assert.ok(Buffer.byteLength(content) < 2097152);
  } finally {
    stop();
    await f.cleanup();
  }
});

test("single committed target, explicit reference precedence and typed relative intensity do not broaden scope", async () => {
  const f = await fixture();
  try {
    const e = structuredClone(
      f.doc.state.expressions!.find((e) => e.expressionId === "e0")!,
    );
    e.parameters.amplitude *= 1.1;
    f.doc = (
      await changeMotion(f.project.root, {
        expectedRevision: f.doc.revision,
        request: "single edit",
        operations: [{ type: "setExpression", expression: e }],
      })
    ).document;
    assert.equal(
      resolve(f, plan("Сделай её слабее.")).value.requirements.length,
      1,
    );
    const explicit = plan("У Object 5 сделай колебания послабее.", {
      type: "recentSuccessfulTargets",
      effect: "inertialOvershoot",
    });
    explicit.requirements[0].target.name = "Object 5";
    const named = resolve(f, explicit, { activeSceneId: "s0" });
    assert.deepEqual(
      named.value.requirements.map((r) => r.target.sourceNodeId),
      ["n5"],
    );
    const relative = plan("Сделай ещё немного слабее.");
    relative.requirements[0].parameters.amplitudeFactor = null;
    relative.requirements[0].parameters.relativeIntensity = "slightlyWeaker";
    const p = resolve(f, relative).value;
    assert.equal(p.requirements[0].parameters.amplitudeFactor, 0.8);
    const before = f.doc.state.expressions!.find(
      (e) => e.expressionId === "e0",
    )!;
    assert.equal(
      apply(f, p).expressions!.find((e) => e.expressionId === "e0")!.parameters
        .amplitude,
      before.parameters.amplitude * 0.8,
    );
  } finally {
    await f.cleanup();
  }
});
test("property-filtered selector preserves the other channel and compact schema/context omit geometry and engine operation contracts", async () => {
  const f = await fixture();
  try {
    const e = structuredClone(
      f.doc.state.expressions!.find((e) => e.expressionId === "e0")!,
    );
    e.expressionId = "ex";
    e.property = "x";
    const a = structuredClone(f.doc.state.animations[0]);
    a.animationId = "ax";
    a.effect = "slideLeft";
    if (a.effect === "slideLeft") a.parameters = { distance: 80, mode: "in" };
    if (e.type === "inertialOvershoot") e.sourceAnimationId = "ax";
    f.doc = (
      await changeMotion(f.project.root, {
        expectedRevision: f.doc.revision,
        request: "add x channel",
        operations: [
          { type: "addAnimation", animation: a },
          { type: "setExpression", expression: e },
        ],
      })
    ).document;
    const p = resolve(
      f,
      plan("У всех объектов с инерцией уменьши колебания по X.", {
        type: "filteredSet",
        effect: "inertialOvershoot",
        property: "x",
      }),
    ).value;
    const next = apply(f, p);
    assert.equal(
      next.expressions!.find((e) => e.expressionId === "ex")!.parameters
        .amplitude,
      e.parameters.amplitude * 0.5,
    );
    assert.deepEqual(
      next.expressions!.find((e) => e.expressionId === "e0"),
      f.doc.state.expressions!.find((e) => e.expressionId === "e0"),
    );
    const compact = semanticContext({
      contextualEditHint: true,
      project: { name: "test" },
      sceneIndex: [],
      objectIndex: [],
      motion: { huge: "x".repeat(10000) },
      motionKnowledge: {
        expressions: [],
        capabilities: { large: "x".repeat(10000) },
      },
      recentSuccessfulActions: recentSuccessfulActions(f.doc),
      recentConversation: [],
    });
    assert.ok(JSON.stringify(compact).length < 3000);
    assert.ok(!JSON.stringify(compact).includes("huge"));
  } finally {
    await f.cleanup();
  }
});
