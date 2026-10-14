import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { evalDatasetSchema } from "../src/harness/evals.js";
import { evalFixture } from "./harness-fixtures.js";
import { readMotion, changeMotion } from "../src/motion/store.js";
import {
  normalizeSemanticGraph,
  semanticGraphSchema,
} from "../src/motion/intent/graph.js";
import { validateIntentPlan } from "../src/motion/intent/planner.js";
import { preflightIntentPlan } from "../src/motion/intent/execution.js";
import { applyOperations } from "../src/motion/operations.js";
import { motionHtml } from "../src/motion/presentation.js";
import { recentSuccessfulActions } from "../src/motion/contextual-resolution.js";
import { stateDigest } from "../src/motion/qa/render.js";
const dataset = evalDatasetSchema.parse(
  JSON.parse(await readFile("harness/evals/benchmark.json", "utf8")),
);
const get = (id: string) => dataset.cases.find((c) => c.evalId === id)!;
async function planFor(
  f: Awaited<ReturnType<typeof evalFixture>>,
  id: string,
  inputState?: Awaited<ReturnType<typeof readMotion>>["state"],
) {
  const state = inputState ?? (await readMotion(f.project)).state;
  const c = get(id),
    plan = normalizeSemanticGraph(
      c.referenceOutput,
      { motion: state },
      c.prompt,
    ),
    diagnostics: unknown[] = [];
  const valid = validateIntentPlan(
    f.project,
    c.prompt,
    plan,
    state.settings.fps,
    { state, onResolution: (v) => diagnostics.push(v) },
  );
  return {
    plan: valid,
    diagnostics,
    preflight: preflightIntentPlan(f.project, state, valid),
  };
}
test("track-only grouped selectors expand once, reject absent/ambiguous tracks and preserve disabled tracks", async () => {
  const f = await evalFixture(get("LIFECYCLE_02_REMOVE_GROUP"));
  try {
    const doc = await readMotion(f.project),
      c = get("LIFECYCLE_02_REMOVE_GROUP"),
      graph = semanticGraphSchema.parse(c.referenceOutput);
    graph.actions[0].targets = [];
    graph.actions[0].selector = {
      type: "explicitObject",
      sceneId: "s0",
      targetIds: ["line", "line2"],
    };
    const plan = validateIntentPlan(
      f.project,
      c.prompt,
      normalizeSemanticGraph(graph, { motion: doc.state }, c.prompt),
      30,
      { state: doc.state },
    );
    assert.equal(plan.requirements.length, 2);
    assert.equal(
      new Set(plan.requirements.flatMap((r) => r.animationIds ?? [])).size,
      2,
    );
    const report = preflightIntentPlan(f.project, doc.state, plan);
    assert.equal(report.status, "PASSED");
    const scoped = structuredClone(graph);
    scoped.clauses[0].text = "В сцене 1 убери Trim Paths.";
    scoped.actions[0].selector = {
      type: "byScene",
      sceneId: "s0",
      effect: "trimPath",
    };
    const scopedPlan = validateIntentPlan(
      f.project,
      scoped.clauses[0].text,
      normalizeSemanticGraph(
        scoped,
        { motion: doc.state },
        scoped.clauses[0].text,
      ),
      30,
      { state: doc.state },
    );
    assert.equal(scopedPlan.requirements.length, 2);
    const broad = structuredClone(scoped);
    broad.clauses[0].text = "Убери Trim Paths.";
    broad.actions[0].selector = {
      type: "byExistingEffect",
      effect: "trimPath",
    };
    const rejected = validateIntentPlan(
      f.project,
      broad.clauses[0].text,
      normalizeSemanticGraph(
        broad,
        { motion: doc.state },
        broad.clauses[0].text,
      ),
      30,
      { state: doc.state },
    );
    assert.throws(
      () => preflightIntentPlan(f.project, doc.state, rejected),
      /SELECTOR_SCOPE_NOT_AUTHORIZED/,
    );
    const expanded = await planFor(f, "LIFECYCLE_02_REMOVE_GROUP");
    assert.equal(expanded.plan.requirements.length, 2);
    const disabled = structuredClone(doc.state);
    disabled.animations[0].enabled = false;
    assert.equal(
      (await planFor(f, "LIFECYCLE_03_REVERSE_GROUP", disabled)).preflight
        .status,
      "PASSED",
    );
    const missing = structuredClone(doc.state);
    missing.animations = [];
    missing.timingDependencies = [];
    await assert.rejects(
      () => planFor(f, "LIFECYCLE_02_REMOVE_GROUP", missing),
      /ANIMATION_TRACK_NOT_FOUND/,
    );
    const ambiguous = structuredClone(doc.state);
    ambiguous.animations.push({
      ...ambiguous.animations[0],
      animationId: "second-independent-track",
      startFrame: 50,
    });
    await assert.rejects(
      () => planFor(f, "LIFECYCLE_02_REMOVE_GROUP", ambiguous),
      /AMBIGUOUS_EFFECT_MATCH/,
    );
  } finally {
    await f.cleanup();
  }
});
test("animation removal freezes dependent absolute time, keeps unrelated effects and Undo/Redo restores dependencies", async () => {
  const f = await evalFixture(get("LIFECYCLE_02_REMOVE_GROUP"));
  try {
    let doc = await readMotion(f.project);
    const original = structuredClone(doc.state),
      geometry = JSON.stringify(f.project.inspection.document);
    const { plan, diagnostics } = await planFor(f, "LIFECYCLE_01_REMOVE_ONE");
    assert.ok(JSON.stringify(diagnostics).includes('"storage":"animation"'));
    const resolved = diagnostics.find(
      (v) => (v as { storage?: string }).storage === "animation",
    ) as {
      objectResolution: { count: number; status: string };
      effectResolution: { matchedAnimationIds: string[] };
    };
    assert.equal(resolved.objectResolution.count, 1);
    assert.equal(resolved.objectResolution.status, "RESOLVED");
    assert.equal(resolved.effectResolution.matchedAnimationIds.length, 1);
    const ids = plan.requirements.flatMap((r) => r.animationIds ?? []);
    const next = applyOperations(
      original,
      ids.map((animationId) => ({ type: "removeAnimation", animationId })),
      f.project,
    );
    assert.equal(
      next.animations.find((a) => a.targetId === "line2")!.startFrame,
      21,
    );
    assert.equal(next.timingDependencies?.length, 0);
    assert.equal(next.animations.length, 1);
    assert.equal(JSON.stringify(f.project.inspection.document), geometry);
    const result = await changeMotion(f.project.root, {
      expectedRevision: doc.revision,
      request: "test remove anchor",
      operations: ids.map((animationId) => ({
        type: "removeAnimation",
        animationId,
      })),
    });
    doc = (
      await changeMotion(f.project.root, {
        expectedRevision: result.document.revision,
        request: "test Undo",
        action: "undo",
      })
    ).document;
    assert.equal(stateDigest(doc.state), stateDigest(original));
    doc = (
      await changeMotion(f.project.root, {
        expectedRevision: doc.revision,
        request: "test Redo",
        action: "redo",
      })
    ).document;
    assert.equal(stateDigest(doc.state), stateDigest(next));
  } finally {
    await f.cleanup();
  }
});
test("historical expressionAction track removal migrates by storage; no expressions required and IDs are preserved on direction edit", async () => {
  const f = await evalFixture(get("LIFECYCLE_03_REVERSE_GROUP"));
  try {
    const doc = await readMotion(f.project),
      g = semanticGraphSchema.parse(
        get("LIFECYCLE_02_REMOVE_GROUP").referenceOutput,
      );
    delete g.actions[0].effectOperation;
    g.actions[0].expressionAction = "remove";
    const p = validateIntentPlan(
      f.project,
      get("LIFECYCLE_02_REMOVE_GROUP").prompt,
      normalizeSemanticGraph(
        g,
        { motion: doc.state },
        get("LIFECYCLE_02_REMOVE_GROUP").prompt,
      ),
      30,
      { state: doc.state },
    );
    assert.equal(
      p.requirements.every(
        (r) =>
          r.effectOperation?.storage === "animation" && !r.expressionAction,
      ),
      true,
    );
    const { plan } = await planFor(f, "LIFECYCLE_03_REVERSE_GROUP");
    const next = applyOperations(
      doc.state,
      doc.state.animations.map((animation) => ({
        type: "updateAnimation",
        animationId: animation.animationId,
        animation: {
          ...animation,
          parameters: { ...animation.parameters, direction: "reverse" },
        },
      })),
      f.project,
    );
    assert.deepEqual(
      next.animations.map((a) => [
        a.animationId,
        a.startFrame,
        a.durationFrames,
        a.easing,
      ]),
      doc.state.animations.map((a) => [
        a.animationId,
        a.startFrame,
        a.durationFrames,
        a.easing,
      ]),
    );
    assert.deepEqual(next.timingDependencies, doc.state.timingDependencies);
    assert.equal(plan.requirements.length, 2);
  } finally {
    await f.cleanup();
  }
});
test("actual renderer reverses spatial reveal, endpoints stay hidden/visible, removal restores full shape", async () => {
  const f = await evalFixture(get("LIFECYCLE_03_REVERSE_GROUP")),
    browser = await chromium.launch({ headless: true });
  try {
    const doc = await readMotion(f.project),
      page = await browser.newPage({
        viewport: {
          width: doc.state.settings.width,
          height: doc.state.settings.height,
        },
      });
    async function pixels(state: typeof doc.state, frame: number) {
      await page.setContent((await motionHtml(f.project, state)).html);
      await page.evaluate(() => window.motionReady);
      await page.evaluate((f) => window.motionFrame(f), frame);
      const shot = await page.screenshot();
      return page.evaluate(async (base64) => {
        const i = new Image();
        i.src = "data:image/png;base64," + base64;
        await i.decode();
        const c = document.createElement("canvas");
        c.width = i.width;
        c.height = i.height;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(i, 0, 0);
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        let left = 0,
          right = 0;
        for (let y = 90; y < 135; y++)
          for (let x = 0; x < c.width; x++) {
            const j = (y * c.width + x) * 4;
            if (data[j] > 180 && data[j + 1] < 100 && data[j + 2] < 100) {
              if (x < 95) left++;
              else right++;
            }
          }
        return { left, right, total: left + right };
      }, shot.toString("base64"));
    }
    const reverse = structuredClone(doc.state);
    for (const a of reverse.animations)
      if (a.effect === "trimPath") a.parameters.direction = "reverse";
    const forwardPixels = await pixels(doc.state, 7),
      reversePixels = await pixels(reverse, 7);
    assert.ok(forwardPixels.left > forwardPixels.right);
    assert.ok(reversePixels.right > reversePixels.left);
    assert.equal((await pixels(reverse, 0)).total, 0);
    const complete = await pixels(reverse, 21),
      removed = await pixels(
        applyOperations(
          reverse,
          reverse.animations.map((a) => ({
            type: "removeAnimation",
            animationId: a.animationId,
          })),
          f.project,
        ),
        7,
      );
    assert.ok(complete.total > 0);
    assert.deepEqual(removed, complete);
  } finally {
    await browser.close();
    await f.cleanup();
  }
});

test("recent track groups resolve from committed actions; dependent expressions prevent destructive base deletion", async () => {
  const f = await evalFixture(get("LIFECYCLE_02_REMOVE_GROUP"));
  try {
    const doc = await readMotion(f.project),
      prompt = "Убери Trim Paths.",
      g = semanticGraphSchema.parse(
        get("LIFECYCLE_02_REMOVE_GROUP").referenceOutput,
      );
    g.clauses[0].text = prompt;
    g.actions[0].targets = [];
    g.actions[0].selector = {
      type: "recentSuccessfulTargets",
      effect: "trimPath",
    };
    const plan = validateIntentPlan(
      f.project,
      prompt,
      normalizeSemanticGraph(g, { motion: doc.state }, prompt),
      30,
      { state: doc.state, recentActions: recentSuccessfulActions(doc, true) },
    );
    assert.equal(plan.requirements.length, 2);
    assert.equal(
      preflightIntentPlan(f.project, doc.state, plan).status,
      "PASSED",
    );
  } finally {
    await f.cleanup();
  }
  const inertia = await evalFixture(get("LIFECYCLE_06_REMOVE_EXPRESSION"));
  try {
    const doc = await readMotion(inertia.project),
      before = stateDigest(doc.state),
      base = doc.state.expressions!.find(
        (e) => e.type === "inertialOvershoot",
      )!;
    assert.ok("sourceAnimationId" in base);
    assert.throws(
      () =>
        applyOperations(
          doc.state,
          [{ type: "removeAnimation", animationId: base.sourceAnimationId }],
          inertia.project,
        ),
      /ANIMATION_HAS_DEPENDENT_EXPRESSION/,
    );
    assert.equal(stateDigest(doc.state), before);
  } finally {
    await inertia.cleanup();
  }
});
