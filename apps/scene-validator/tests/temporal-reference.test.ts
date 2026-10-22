import test from "node:test";
import assert from "node:assert/strict";
import { identityFixture, node } from "./identity-fixture.js";
import { readMotion, changeMotion } from "../src/motion/store.js";
import { normalizeSemanticGraph } from "../src/motion/intent/graph.js";
import { validateIntentPlan } from "../src/motion/intent/planner.js";
import {
  compileTasks,
  compileRequirement,
} from "../src/motion/intent/compiler.js";
import { preflightIntentPlan } from "../src/motion/intent/execution.js";
import { applyOperations } from "../src/motion/operations.js";
import type { Animation, MotionState } from "../src/motion/schema.js";
import type { LoadedProject } from "../src/types.js";
import { evaluateAnimation } from "../src/motion/engine.js";
const anim = (
  id: string,
  targetId: string,
  effect: "fadeIn" | "scaleIn" | "slideUp" | "rotation",
  startFrame = 0,
  durationFrames = 8,
): Animation =>
  ({
    animationId: id,
    targetId,
    sceneId: "s0",
    effect,
    startFrame,
    durationFrames,
    easing: "linear",
    enabled: true,
    parameters:
      effect === "slideUp"
        ? { distance: 30, mode: "in" }
        : effect === "rotation"
          ? { from: 0, to: 20 }
          : { from: effect === "scaleIn" ? 0.5 : 0, to: 1 },
  }) as Animation;
async function setup() {
  const f = await identityFixture(2, (scenes) => {
    scenes[0].children = [
      node("a", "Alpha"),
      node("b", "Beta"),
      node("c", "Gamma"),
      node("d", "Delta"),
    ];
    scenes[1].children = [node("b2", "Beta")];
  });
  const doc = await readMotion(f.project);
  const state = applyOperations(
    doc.state,
    [
      anim("A", "a", "slideUp"),
      anim("B", "b", "fadeIn", 25),
      anim("C", "c", "scaleIn", 40),
      anim("D", "d", "rotation", 15),
    ].map((animation) => ({ type: "addAnimation", animation })),
    f.project,
  );
  return { ...f, state };
}
function plan(
  project: LoadedProject,
  state: MotionState,
  {
    target = "Beta",
    scene = "s0",
    anchor = "Alpha",
    anchorEffect,
    endpoint = "end",
    offset = 0,
    start,
    source,
    explicitId,
  }: {
    target?: string;
    scene?: string;
    anchor?: string;
    anchorEffect?: string;
    endpoint?: "start" | "end";
    offset?: number;
    start?: number;
    source?: string;
    explicitId?: string;
  } = {},
) {
  const request =
    source ??
    `${target} starts when ${anchor} ${endpoint === "end" ? "finishes" : "starts"}.`;
  const graph = {
    schemaVersion: "semantic-graph/1.0",
    clauses: [{ clauseId: "source", text: request }],
    actions: [
      {
        actionId: "mutation",
        clauseId: "source",
        kind: "editAnimation",
        scene,
        targets: [target],
        techniques: [],
        parameters: [],
        relation: "unchanged",
        effectOperation: { storage: "animation", action: "updateTiming" },
        ...(start !== undefined
          ? { start: { unit: "frames", value: start } }
          : {
              temporalReference: {
                kind: "existingAnimation",
                target: { name: anchor, sceneId: "s0" },
                ...(anchorEffect ? { effect: anchorEffect } : {}),
                ...(explicitId ? { animationId: explicitId } : {}),
                endpoint,
              },
            }),
        delayFrames: offset,
        constraints: [],
        unresolvedReason: null,
      },
    ],
    assumptions: [],
  };
  return validateIntentPlan(
    project,
    request,
    normalizeSemanticGraph(graph, { motion: state }, request),
    state.settings.fps,
    { state },
  );
}
function execute(
  project: LoadedProject,
  state: MotionState,
  p: ReturnType<typeof plan>,
) {
  preflightIntentPlan(project, state, p);
  return applyOperations(
    state,
    compileRequirement(project, state, p, compileTasks(project, p)[0])
      .operations,
    project,
  );
}
test("existing read-only anchors, both endpoints and signed offsets preserve source and target identities", async () => {
  const f = await setup();
  try {
    for (const fps of [24, 30, 60])
      for (const endpoint of ["start", "end"] as const)
        for (const offset of [0, 5, -3]) {
          const state = structuredClone(f.state);
          state.settings.fps = fps;
          state.animations.find((a) => a.animationId === "A")!.startFrame = 10;
          const p = plan(f.project, state, { endpoint, offset }),
            next = execute(f.project, state, p);
          assert.equal(p.requirements.length, 1);
          assert.equal(p.requirements[0].animationIds![0], "B");
          assert.equal(
            p.requirements[0].timing.reference!.resolvedAnimationId,
            "A",
          );
          assert.equal(
            next.animations.find((a) => a.animationId === "B")!.startFrame,
            10 + (endpoint === "end" ? 8 : 0) + offset,
          );
          assert.deepEqual(
            next.animations.find((a) => a.animationId === "A"),
            state.animations.find((a) => a.animationId === "A"),
          );
          assert.equal(next.timingDependencies?.length, 1);
          const twice = execute(f.project, next, p);
          assert.deepEqual(twice, next);
        }
  } finally {
    await f.cleanup();
  }
});
test("replace anchor, duration propagation, remove/freeze, Undo/Redo and rejected transactions preserve authoritative state", async () => {
  const f = await setup();
  try {
    const first = execute(f.project, f.state, plan(f.project, f.state)),
      replaced = execute(
        f.project,
        first,
        plan(f.project, first, { anchor: "Gamma", anchorEffect: "scaleIn" }),
      );
    assert.equal(replaced.timingDependencies!.length, 1);
    assert.equal(replaced.timingDependencies![0].anchorAnimationId, "C");
    const shifted = applyOperations(
      replaced,
      [{ type: "setDuration", animationId: "C", durationFrames: 12 }],
      f.project,
    );
    assert.equal(
      shifted.animations.find((a) => a.animationId === "B")!.startFrame,
      52,
    );
    const removed = applyOperations(
      shifted,
      [{ type: "removeAnimation", animationId: "C" }],
      f.project,
    );
    assert.equal(
      removed.animations.find((a) => a.animationId === "B")!.startFrame,
      52,
    );
    assert.equal(removed.timingDependencies?.length, 0);
    const doc = await readMotion(f.project);
    const seed = (
      await changeMotion(f.project.root, {
        expectedRevision: doc.revision,
        request: "seed",
        operations: f.state.animations.map((animation) => ({
          type: "addAnimation",
          animation,
        })),
      })
    ).document;
    const applied = (
      await changeMotion(f.project.root, {
        expectedRevision: seed.revision,
        request: "dependency",
        operations: compileRequirement(
          f.project,
          seed.state,
          plan(f.project, seed.state),
          compileTasks(f.project, plan(f.project, seed.state))[0],
        ).operations,
      })
    ).document;
    const undone = (
      await changeMotion(f.project.root, {
        expectedRevision: applied.revision,
        request: "undo",
        action: "undo",
      })
    ).document;
    assert.deepEqual(undone.state, seed.state);
    const redone = (
      await changeMotion(f.project.root, {
        expectedRevision: undone.revision,
        request: "redo",
        action: "redo",
      })
    ).document;
    assert.deepEqual(redone.state, applied.state);
    await assert.rejects(
      () =>
        changeMotion(f.project.root, {
          expectedRevision: seed.revision,
          request: "stale",
          operations: [],
        }),
      /изменилась/,
    );
    assert.deepEqual((await readMotion(f.project)).state, redone.state);
  } finally {
    await f.cleanup();
  }
});
test("missing/ambiguous references never fall back to another effect; real/self cycles expose canonical paths", async () => {
  const f = await setup();
  try {
    const missing = structuredClone(f.state);
    missing.animations = missing.animations.filter(
      (a) => a.animationId !== "A",
    );
    assert.throws(() => plan(f.project, missing), /MISSING_TEMPORAL_ANCHOR/);
    const ambiguous = applyOperations(
      f.state,
      // Synchronized Slide+Fade now has an objective primary movement role.
      // Two independent motion intervals remain genuinely ambiguous.
      [{ type: "addAnimation", animation: anim("A2", "a", "rotation", 3, 8) }],
      f.project,
    );
    assert.throws(
      () => plan(f.project, ambiguous),
      /AMBIGUOUS_TEMPORAL_ANCHOR/,
    );
    assert.equal(
      execute(
        f.project,
        ambiguous,
        plan(f.project, ambiguous, { anchorEffect: "slideUp" }),
      ).timingDependencies!.length,
      1,
    );
    const next = execute(f.project, f.state, plan(f.project, f.state));
    assert.throws(
      () =>
        execute(
          f.project,
          next,
          plan(f.project, next, { target: "Alpha", anchor: "Beta" }),
        ),
      /Timing dependency cycle: (A -> B -> A|B -> A -> B)/,
    );
    assert.throws(
      () =>
        execute(
          f.project,
          f.state,
          plan(f.project, f.state, { target: "Beta", anchor: "Beta" }),
        ),
      /Timing dependency cycle: B -> B/,
    );
    assert.equal(f.state.timingDependencies?.length ?? 0, 0);
  } finally {
    await f.cleanup();
  }
});
test("32 seeded acyclic graph metamorphisms hold across effects; unrelated edits and action order do not affect schedule", async () => {
  const f = await setup();
  try {
    let seed = 1729;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };
    for (let i = 0; i < 32; i++) {
      const n = 1 + (rnd() % 5),
        base = structuredClone(f.state);
      base.animations.find((a) => a.animationId === "A")!.durationFrames =
        3 + (rnd() % 5);
      const b = plan(f.project, base),
        afterB = execute(f.project, base, b),
        afterC = execute(
          f.project,
          afterB,
          plan(f.project, afterB, { target: "Gamma", anchor: "Beta" }),
        );
      const oldB = afterC.animations.find(
          (a) => a.animationId === "B",
        )!.startFrame,
        oldC = afterC.animations.find((a) => a.animationId === "C")!.startFrame;
      const moved = applyOperations(
        afterC,
        [
          {
            type: "setDuration",
            animationId: "A",
            durationFrames:
              afterC.animations.find((a) => a.animationId === "A")!
                .durationFrames + n,
          },
        ],
        f.project,
      );
      assert.equal(
        moved.animations.find((a) => a.animationId === "B")!.startFrame,
        oldB + n,
      );
      assert.equal(
        moved.animations.find((a) => a.animationId === "C")!.startFrame,
        oldC + n,
      );
      const unrelated = applyOperations(
        moved,
        [{ type: "setDuration", animationId: "D", durationFrames: 3 }],
        f.project,
      );
      assert.equal(
        unrelated.animations.find((a) => a.animationId === "B")!.startFrame,
        oldB + n,
      );
      const edges = afterC.timingDependencies!;
      const order = applyOperations(
          base,
          edges.map((dependency) => ({
            type: "setTimingDependency",
            dependency,
          })),
          f.project,
        ),
        reversed = applyOperations(
          base,
          [...edges]
            .reverse()
            .map((dependency) => ({ type: "setTimingDependency", dependency })),
          f.project,
        );
      assert.deepEqual(order.animations, reversed.animations);
    }
  } finally {
    await f.cleanup();
  }
});
test("absolute project frames and cross-scene end references use current FPS without modifying anchors", async () => {
  const f = await setup();
  try {
    const boundary = f.state.blocks[1].startFrame;
    let state = applyOperations(
      f.state,
      [
        {
          type: "addAnimation",
          animation: {
            ...anim("B2", "b2", "fadeIn", boundary + 20, 10),
            sceneId: "s1",
          },
        },
        {
          type: "updateAnimation",
          animationId: "A",
          animation: {
            ...f.state.animations.find((a) => a.animationId === "A")!,
            startFrame: boundary - 10,
            durationFrames: 10,
          },
        },
      ],
      f.project,
    );
    state = execute(
      f.project,
      state,
      plan(f.project, state, { scene: "s1", target: "Beta" }),
    );
    assert.equal(
      state.animations.find((a) => a.animationId === "B2")!.startFrame,
      boundary,
    );
    for (const fps of [24, 30, 60]) {
      state.settings.fps = fps;
      const absolute = execute(
        f.project,
        state,
        plan(f.project, state, {
          scene: "s1",
          target: "Beta",
          start: boundary + 15,
        }),
      );
      assert.equal(
        absolute.animations.find((a) => a.animationId === "B2")!.startFrame,
        boundary + 15,
      );
      assert.equal(absolute.timingDependencies?.length, 1);
      assert.equal(absolute.timingDependencies?.[0].offsetFrames,15);
    }
    const b = state.animations.find((a) => a.animationId === "B2")!;
    assert.equal(evaluateAnimation(b, b.startFrame).opacity, 0);
    assert.equal(
      evaluateAnimation(b, b.startFrame + b.durationFrames).opacity,
      1,
    );
  } finally {
    await f.cleanup();
  }
});
test("timing-only actions can schedule generic keyframes without advertising unsupported creation; recent references query committed live membership", async () => {
  const f = await setup();
  try {
    const generic = applyOperations(
      f.state,
      [
        {
          type: "updateAnimation",
          animationId: "B",
          animation: {
            animationId: "B",
            targetId: "b",
            sceneId: "s0",
            startFrame: 25,
            durationFrames: 8,
            easing: "linear",
            enabled: true,
            effect: "keyframes",
            parameters: {
              property: "opacity",
              points: [
                { frame: 0, value: 0 },
                { frame: 8, value: 1 },
              ],
            },
          },
        },
      ],
      f.project,
    );
    const p = plan(f.project, generic),
      next = execute(f.project, generic, p);
    assert.equal(
      next.animations.find((a) => a.animationId === "B")!.startFrame,
      8,
    );
    assert.deepEqual(
      next.animations.find((a) => a.animationId === "B")!.parameters,
      generic.animations.find((a) => a.animationId === "B")!.parameters,
    );
    const doc = await readMotion(f.project),
      seeded = (
        await changeMotion(f.project.root, {
          expectedRevision: doc.revision,
          request: "seed recent committed A",
          operations: f.state.animations.map((animation) => ({
            type: "addAnimation",
            animation,
          })),
        })
      ).document;
    const { recentSuccessfulActions } = await import(
      "../src/motion/contextual-resolution.js"
    );
    const recent = recentSuccessfulActions(seeded, true),
      input = plan(f.project, seeded.state);
    input.requirements[0].timing.reference = {
      kind: "recentCommittedAnimation",
      target: {},
      effect: "slideUp",
      endpoint: "end",
    };
    const resolved = validateIntentPlan(
      f.project,
      input.sourceClauses![0].text,
      input,
      30,
      { state: seeded.state, recentActions: recent },
    );
    assert.equal(
      resolved.requirements[0].timing.reference!.resolvedAnimationId,
      "A",
    );
    assert.equal(
      resolved.requirements[0].timing.reference!.resolvedFromActionId,
      recent.find((a) => a.effect === "slideUp")!.actionId,
    );
    const stale = structuredClone(input);
    stale.requirements[0].timing.reference = {
      kind: "recentCommittedAnimation",
      target: {},
      effect: "slideUp",
      endpoint: "end",
    };
    const deleted = applyOperations(
      seeded.state,
      [{ type: "removeAnimation", animationId: "A" }],
      f.project,
    );
    assert.throws(
      () =>
        validateIntentPlan(f.project, stale.sourceClauses![0].text, stale, 30, {
          state: deleted,
          recentActions: recent,
        }),
      /MISSING_TEMPORAL_ANCHOR_RECENT_ACTION/,
    );
  } finally {
    await f.cleanup();
  }
});
