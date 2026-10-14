import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { evalDatasetSchema } from "../src/harness/evals.js";
import { evalFixture } from "./harness-fixtures.js";
import {
  GraphReferenceError,
  normalizeSemanticGraph,
  semanticGraphSchema,
} from "../src/motion/intent/graph.js";
import {
  SemanticProvider,
  validateIntentPlan,
} from "../src/motion/intent/planner.js";
import type { CodexProvider } from "../src/motion/provider.js";
import { inspectSemanticCoverage } from "../src/motion/intent/coverage.js";
import { readMotion } from "../src/motion/store.js";
import { executeMotion } from "../src/motion/service.js";
import { registerProvider } from "../src/harness/providers/index.js";
import { mergeTargetedRepair } from "../src/motion/intent/repair.js";
const dataset = evalDatasetSchema.parse(
  JSON.parse(await readFile("harness/evals/benchmark.json", "utf8")),
);
const c = dataset.cases.find((c) => c.evalId === "WORKFLOW_04_EIGHT_OBJECTS")!;
test("invalid graph anchor gets a bounded reference-only patch; omitted sequential relation remains a real failure", async () => {
  const f = await setup();
  try {
    const graph = semanticGraphSchema.parse(c.referenceOutput);
    const ribbon = graph.actions.find((a) => a.targets.includes("лента 2"))!;
    const actualAnchor = ribbon.dependsOn!;
    ribbon.dependsOn = "unknown-action";
    let failure: GraphReferenceError | undefined;
    try {
      normalizeSemanticGraph(graph, f.context, c.prompt);
    } catch (error) {
      assert.ok(error instanceof GraphReferenceError);
      failure = error;
    }
    assert.ok(failure);
    let calls = 0;
    const provider = new SemanticProvider(
      async () =>
        ({
          structured: async (context: unknown) => {
            calls++;
            assert.ok(!JSON.stringify(context).includes('"motion"'));
            return { actionId: ribbon.actionId, reference: actualAnchor };
          },
        }) as unknown as CodexProvider,
    );
    const fixed = await provider.interpret(f.context, c.prompt, {
      graphReferenceRepair: { graph: failure.graph, issue: failure.issue },
    });
    assert.equal(calls, 1);
    assert.equal(
      validateIntentPlan(f.project, c.prompt, fixed, 30, { state: f.doc.state })
        .requirements.length,
      10,
    );
    const missing = structuredClone(fixed);
    const requirement = missing.requirements.find(
      (r) => r.target.name === "лента 2",
    )!;
    requirement.timing.relation = "sceneStart";
    requirement.timing.anchorRequirementId = null;
    assert.throws(
      () =>
        validateIntentPlan(f.project, c.prompt, missing, 30, {
          state: f.doc.state,
        }),
      /MISSING_SEQUENTIAL_DEPENDENCY/,
    );
  } finally {
    await f.cleanup();
  }
});
async function setup() {
  const f = await evalFixture(c),
    doc = await readMotion(f.project);
  return {
    ...f,
    doc,
    context: {
      sceneIndex: f.project.inspection.document.scenes.map((s) => ({
        sceneId: s.sceneId,
        index: s.index,
      })),
      motion: doc.state,
    },
  };
}
test("compact graph expands groups with stable identities, exact source spans and original frame units", async () => {
  const f = await setup();
  try {
    const graph = semanticGraphSchema.parse(c.referenceOutput),
      plan = normalizeSemanticGraph(graph, f.context, c.prompt);
    assert.equal(plan.requirements.length, 10);
    assert.equal(
      new Set(plan.requirements.map((r) => r.semanticActionId)).size,
      7,
    );
    assert.equal(
      plan.requirements
        .filter((r) => r.kind === "sceneTiming")
        .map((r) => r.timing.startSeconds)
        .join(","),
      "1,3",
    );
    const valid = validateIntentPlan(f.project, c.prompt, plan, 30, {
      state: f.doc.state,
    });
    assert.equal(
      new Set(
        valid.requirements.flatMap((r) =>
          r.target.sourceNodeId ? [r.target.sourceNodeId] : [],
        ),
      ).size,
      8,
    );
    const before = JSON.stringify(valid);
    const report = inspectSemanticCoverage(f.project, c.prompt, valid, 30);
    assert.equal(report.status, "PASSED");
    assert.equal(
      JSON.stringify(valid),
      before,
      "coverage inspection must be pure",
    );
    const second = report.clauses.find((x) =>
      x.sourceText.includes("аналогично лента 2"),
    )!;
    assert.ok(
      second.requirementIds.every(
        (id) =>
          valid.requirements.find((r) => r.requirementId === id)?.target
            .name !== "текст 2",
      ),
    );
    const shuffled = { ...graph, actions: [...graph.actions].reverse() };
    assert.deepEqual(
      normalizeSemanticGraph(shuffled, f.context, c.prompt)
        .requirements.map((r) => r.requirementId)
        .sort(),
      plan.requirements.map((r) => r.requirementId).sort(),
    );
    const lost = structuredClone(plan);
    lost.requirements.find((r) => r.target.name === "куар")!.techniques = [
      "slideUp",
      "inertialOvershoot",
    ];
    assert.throws(
      () =>
        validateIntentPlan(f.project, c.prompt, lost, 30, {
          state: f.doc.state,
        }),
      /MISSING_EXPLICIT_TECHNIQUE/,
    );
    const cycle = structuredClone(plan);
    const ribbons = cycle.requirements.filter((r) =>
      r.techniques.includes("trimPath"),
    );
    ribbons[0].timing.anchorRequirementId = ribbons[1].requirementId;
    ribbons[0].timing.relation = "afterRequirement";
    assert.throws(
      () =>
        validateIntentPlan(f.project, c.prompt, cycle, 30, {
          state: f.doc.state,
        }),
      /Temporal dependency cycle/,
    );
  } finally {
    await f.cleanup();
  }
});
test("safe missing provenance edge repairs locally; targeted repair cannot alter unrelated actions", async () => {
  const f = await setup();
  try {
    const plan = normalizeSemanticGraph(c.referenceOutput, f.context, c.prompt);
    const group = plan.requirements.filter((r) => r.semanticActionId === "a1");
    const row = plan.coverage.find((row) =>
      row.requirementIds.includes(group[0].requirementId),
    )!;
    row.requirementIds.shift();
    const repaired = validateIntentPlan(f.project, c.prompt, plan, 30, {
      state: f.doc.state,
    });
    assert.ok(
      repaired.coverage
        .find((r) => r.sourceText === row.sourceText)
        ?.requirementIds.includes(group[0].requirementId),
    );
    assert.throws(
      () =>
        mergeTargetedRepair(
          repaired,
          {
            requirements: [repaired.requirements.at(-1)!],
            coverageRows: [row],
          },
          [
            {
              sourceText: group[0].sourceText,
              requirementIds: [group[0].requirementId],
            },
          ],
        ),
      /REPAIR_SCOPE/,
    );
  } finally {
    await f.cleanup();
  }
});
test("production native graph path commits eight objects in one fixture call with real QA and preflight", async () => {
  const f = await setup();
  let calls = 0;
  const stop = registerProvider("graph-wire-fixture", () => ({
    id: "graph-wire-fixture",
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
      assert.equal(
        (
          req.responseSchema as {
            properties: { schemaVersion: { const: string } };
          }
        ).properties.schemaVersion.const,
        "semantic-graph/1.0",
      );
      const graph = semanticGraphSchema.parse(c.referenceOutput);
      const wire = {
        ...graph,
        actions: graph.actions.map((a) => ({
          start: null,
          relation: null,
          dependsOn: null,
          inheritFrom: null,
          delaySeconds: null,
          selector: null,
          expressionAction: null,
          ...a,
        })),
      };
      return {
        output: wire,
        usage: null,
        estimatedCost: null,
        latencyMs: 0,
        diagnostics: ["native graph fixture, not live model"],
        toolCalls: [],
      };
    },
  }));
  try {
    const result = await executeMotion(
      f.project,
      {
        request: c.prompt,
        mode: "create",
        expectedRevision: f.doc.revision,
        settings: { provider: "graph-wire-fixture", model: "" },
      },
      () => {},
      { config: { maxLLMCalls: 1, maxRepairAttempts: 0 } },
    );
    assert.equal(
      result.reconciliation?.status,
      "SUCCESS",
      JSON.stringify(result),
    );
    assert.equal(calls, 1);
    assert.equal(result.reconciliation?.selectedObjectCount, 8);
    assert.equal(result.reconciliation?.userIntentCount, 7);
    const after = await readMotion(f.project);
    assert.equal(after.state.blocks[1].startFrame, 30);
    assert.equal(after.state.blocks[2].startFrame, 90);
    assert.equal(after.state.expressions?.length, 6);
    assert.equal(after.state.timingDependencies?.length, 1);
    const preflight = JSON.parse(
      await readFile(
        `${f.project.root}/motion/ai/${result.id}/compilation-preflight.json`,
        "utf8",
      ),
    );
    assert.equal(preflight.status, "PASSED");
    assert.equal(preflight.operationCount, 22);
    const plate = after.state.animations.find(
      (a) => a.targetId === "plate" && a.effect === "slideUp",
    )!;
    assert.ok(
      plate.effect === "slideUp" &&
        60 + plate.parameters.distance >
          f.project.inspection.document.scenes[1].height,
      "viewport clearance is geometry-derived",
    );
  } finally {
    stop();
    await f.cleanup();
  }
});
import { locateSource } from "../src/motion/intent/provenance.js";
test("source provenance safely normalizes whitespace and requires an explicit duplicate occurrence", () => {
  assert.deepEqual(
    locateSource("QR\n\u00a0 появляется снизу.", "QR появляется снизу."),
    {
      text: "QR\n\u00a0 появляется снизу.",
      start: 0,
      end: 22,
      correction: "WHITESPACE_ONLY",
    },
  );
  assert.throws(
    () => locateSource("QR снизу. QR снизу.", "QR снизу."),
    /AMBIGUOUS/,
  );
  assert.equal(locateSource("QR снизу. QR снизу.", "QR снизу.", 1).start, 10);
  assert.throws(() => locateSource("QR снизу.", "QR сверху."), /NOT_VERBATIM/);
});
import { identityFixture, node } from "./identity-fixture.js";
import { preflightIntentPlan } from "../src/motion/intent/execution.js";
test("same target in separate source clauses stays separate; dependency anchors the requested track, not an unrelated rotation", async () => {
  const f = await identityFixture(1, (scenes) => {
    scenes[0].children = [node("qr", "QR", 20, 20)];
  });
  try {
    const state = (await readMotion(f.project)).state;
    state.animations = [
      {
        animationId: "old_rotation",
        sceneId: "s0",
        targetId: "qr",
        effect: "rotation",
        parameters: { from: 0, to: 20 },
        startFrame: 0,
        durationFrames: 10,
        easing: "linear",
        enabled: true,
      },
    ];
    const prompt = "QR снизу. QR через Fade одновременно.";
    const graph = {
      schemaVersion: "semantic-graph/1.0",
      clauses: [
        { clauseId: "move", text: "QR снизу." },
        { clauseId: "fade", text: "QR через Fade одновременно." },
      ],
      actions: [
        {
          actionId: "move",
          clauseId: "move",
          scene: "s0",
          kind: "objectAnimation",
          targets: ["QR"],
          techniques: ["slideUp"],
          parameters: [],
          constraints: [],
          unresolvedReason: null,
        },
        {
          actionId: "fade",
          clauseId: "fade",
          scene: "s0",
          kind: "objectAnimation",
          targets: ["QR"],
          techniques: ["fadeIn"],
          parameters: [],
          constraints: [],
          unresolvedReason: null,
          dependsOn: "move",
          relation: "withRequirement",
        },
      ],
      assumptions: [],
    };
    const plan = validateIntentPlan(
      f.project,
      prompt,
      normalizeSemanticGraph(
        graph,
        { sceneIndex: [{ sceneId: "s0", index: 0 }], motion: state },
        prompt,
      ),
      30,
      { state },
    );
    assert.equal(preflightIntentPlan(f.project, state, plan).status, "PASSED");
  } finally {
    await f.cleanup();
  }
});
test("explicit scene frame units remain exact at different project FPS", async () => {
  const f = await setup();
  try {
    for (const fps of [24, 30, 60]) {
      const plan = normalizeSemanticGraph(
        c.referenceOutput,
        {
          ...f.context,
          motion: {
            ...f.doc.state,
            settings: { ...f.doc.state.settings, fps },
          },
        },
        c.prompt,
      );
      assert.deepEqual(
        plan.requirements
          .filter((r) => r.kind === "sceneTiming")
          .map((r) => Math.round(r.timing.startSeconds! * fps)),
        [30, 90],
      );
    }
  } finally {
    await f.cleanup();
  }
});
