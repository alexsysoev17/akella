import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  intentFixture,
  objectRequirement,
  emptyParameters,
  compositeRequest,
} from "./intent-fixture.js";
import {
  registerProvider,
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderResponse,
} from "../src/harness/providers/index.js";
import { executeMotion } from "../src/motion/service.js";
import { readMotion, changeMotion } from "../src/motion/store.js";
import {
  HarnessRun,
  readRuns,
  recoverInterruptedRuns,
} from "../src/harness/runtime.js";
import { harnessConfigSchema } from "../src/harness/config.js";
import { agentContext } from "../src/harness/context.js";
import { saveExperience, experienceSearch } from "../src/harness/experience.js";
import {
  collectImprovements,
  evaluateCandidate,
} from "../src/harness/improvements.js";
import {
  harnessMetrics,
  regressionComparison,
} from "../src/harness/metrics.js";
import { capabilityCatalog } from "../src/motion-library/registry/capabilities.js";
import { semanticPlan } from "../src/motion/intent/planner.js";
import { redact } from "../src/harness/security.js";
class MockAdapter implements ProviderAdapter {
  readonly id = "fixture-provider";
  readonly mode = "mock" as const;
  constructor(private action: (r: ProviderRequest) => Promise<unknown>) {}
  capabilities() {
    return {
      structuredOutput: true,
      nativeToolCalling: false,
      cancellation: true,
      usage: true,
      nativeOutputTokenLimit: false,
    };
  }
  async generate(r: ProviderRequest): Promise<ProviderResponse> {
    return {
      output: await this.action(r),
      usage: { inputTokens: 100, outputTokens: 20 },
      estimatedCost: null,
      latencyMs: 1,
      diagnostics: ["infrastructure mock, not live provider"],
      toolCalls: [],
    };
  }
}
const single = (request: string, edit = false) => {
  const r = objectRequirement(
    "qr",
    "s1",
    "qr",
    "куар",
    edit ? ["inertialOvershoot"] : ["slideUp", "fadeIn", "inertialOvershoot"],
    request,
  );
  if (edit) {
    r.kind = "editAnimation";
    r.parameters.amplitudeFactor = 0.5;
    r.timing.relation = "unchanged";
  }
  return {
    schemaVersion: "1.0.0" as const,
    requirements: [r],
    coverage: [
      {
        sourceText: request,
        requirementIds: ["qr"],
        classification: "executable" as const,
        explanation: "synthetic expected intent",
      },
    ],
    assumptions: [],
  };
};
async function input(
  f: Awaited<ReturnType<typeof intentFixture>>,
  request: string,
) {
  return {
    mode: "create",
    request,
    selectedObjectId: "qr",
    selectedSceneId: "s1",
    activeSceneId: "s1",
    settings: { provider: "fixture-provider", model: "" },
    expectedRevision: (await readMotion(f.project)).revision,
  };
}
test("Harness infrastructure: one mock call, genuine selective Chromium QA, persisted reports, edit-only amplitude, provider-independent history and undo/redo", async () => {
  const f = await intentFixture();
  let calls = 0;
  const unregister = registerProvider(
    "fixture-provider",
    () =>
      new MockAdapter(async (req) => {
        calls++;
        const { userRequest } = JSON.parse(req.messages[1].content);
        return single(userRequest, calls > 1);
      }),
  );
  try {
    const first = await executeMotion(
      f.project,
      await input(f, "куар снизу с фейдом и инерцией"),
    );
    assert.equal(first.reconciliation?.status, "SUCCESS");
    assert.equal(calls, 1);
    const before = (await readMotion(f.project)).state;
    const second = await executeMotion(
      f.project,
      await input(f, "Сделай колебания куар вдвое слабее"),
    );
    assert.equal(second.reconciliation?.status, "SUCCESS");
    assert.equal(calls, 2);
    const doc = await readMotion(f.project);
    assert.deepEqual(doc.state.animations, before.animations);
    assert.equal(
      doc.state.expressions![0].parameters.amplitude,
      before.expressions![0].parameters.amplitude * 0.5,
    );
    const runs = await readRuns(f.project.root);
    assert.equal(runs.length, 2);
    for (const r of runs) {
      assert.equal(r.status, "SUCCESS");
      const m = r.metrics as { llmCalls: number; renderedQAFrames: number };
      assert.equal(m.llmCalls, 1);
      assert.ok(m.renderedQAFrames < 50);
      assert.ok((r.knowledgeReferences as unknown[]).length > 4);
      assert.equal(
        (r.metrics as { estimatedCost: unknown }).estimatedCost,
        null,
      );
    }
    assert.equal(
      harnessMetrics(runs).sampleCount,
      0,
      "mocks excluded from live metrics",
    );
    assert.equal(harnessMetrics(runs, true).firstPassSuccessRate, 1);
    const undone = (
      await changeMotion(f.project.root, {
        expectedRevision: doc.revision,
        action: "undo",
        request: "undo",
      })
    ).document;
    assert.deepEqual(undone.state, before);
    const redone = (
      await changeMotion(f.project.root, {
        expectedRevision: undone.revision,
        action: "redo",
        request: "redo",
      })
    ).document;
    assert.deepEqual(redone.state, doc.state);
  } finally {
    unregister();
    await f.cleanup();
  }
});
test("Context progressive disclosure and versions; bounded bytes; capability schema matches existing evaluator", async () => {
  const f = await intentFixture();
  try {
    const state = (await readMotion(f.project)).state;
    const cfg = harnessConfigSchema.parse({});
    const c = await agentContext(
      f.project,
      state,
      {
        request: "куар снизу",
        selectedObjectId: "qr",
        selectedSceneId: "s1",
        activeSceneId: "s1",
      },
      [],
      cfg,
    );
    assert.equal(c.value.scenes.length, 1);
    assert.equal(c.value.scenes[0].objects.length, 1);
    assert.ok(!JSON.stringify(c.value).includes("vectorPaths"));
    assert.ok(c.references.some((r) => r.id === "capabilities"));
    assert.ok(c.bytes < cfg.maxContextBytes);
    assert.ok(
      (
        await agentContext(
          f.project,
          state,
          {
            request: "куар снизу",
            selectedObjectId: "qr",
            selectedSceneId: "s1",
            activeSceneId: "s1",
          },
          [],
          cfg,
        )
      ).cacheHit,
    );
    await assert.rejects(
      agentContext(
        f.project,
        state,
        { request: "куар " + "x".repeat(5000), activeSceneId: "s1" },
        [],
        { ...cfg, maxContextBytes: 4000 },
      ),
      /CONTEXT_BUDGET/,
    );
    const timingContext = await agentContext(
      f.project,
      state,
      { request: "сцена 2 начинается на 1 секунде", activeSceneId: "s0" },
      [],
      cfg,
    );
    assert.equal(timingContext.value.scenes[0].sceneId, "s1");
    const catalog = capabilityCatalog();
    assert.ok(
      catalog
        .find((c) => c.id === "trimPath")
        ?.supportedObjectTypes.includes("VECTOR"),
    );
    assert.ok(
      catalog.every((c) => c.parameterSchema && c.implementationReference),
    );
  } finally {
    await f.cleanup();
  }
});
test("Provider cancellation even if adapter ignores abort; call/output/context budgets; unsupported tools; last Motion State survives", async () => {
  const f = await intentFixture();
  try {
    const controller = new AbortController();
    const run = await HarnessRun.start(
      f.project,
      randomUUID(),
      "synthetic",
      "fixture-provider",
      "",
      controller.signal,
    );
    const pending = run.invoke(new MockAdapter(() => new Promise(() => {})), {
      messages: [],
      responseSchema: {},
      timeoutMs: 1000,
      maxOutputTokens: 100,
      signal: controller.signal,
    });
    controller.abort(new Error("CANCELLED"));
    await assert.rejects(pending, /CANCELLED/);
    await run.finish("CANCELLED");
    const limited = await HarnessRun.start(
      f.project,
      randomUUID(),
      "synthetic",
      "fixture-provider",
      "",
      undefined,
      { maxLLMCalls: 1 },
    );
    const req = {
      messages: [],
      responseSchema: {},
      timeoutMs: 1000,
      maxOutputTokens: 100,
    };
    await limited.invoke(new MockAdapter(async () => ({})), req);
    await assert.rejects(
      limited.invoke(new MockAdapter(async () => ({})), req),
      /LLM_CALL_BUDGET/,
    );
    await limited.finish("FAILED");
    const bad = await HarnessRun.start(
      f.project,
      randomUUID(),
      "synthetic",
      "fixture-provider",
      "",
    );
    const adapter = new MockAdapter(async () => ({}));
    adapter.generate = async () => ({
      output: {},
      usage: null,
      estimatedCost: null,
      latencyMs: 1,
      diagnostics: [],
      toolCalls: [{ name: "eval", arguments: "malicious" }],
    });
    await assert.rejects(bad.invoke(adapter, req), /UNSUPPORTED_TOOL_CALL/);
    await bad.finish("FAILED");
    assert.equal((await readMotion(f.project)).revision, "initial");
  } finally {
    await f.cleanup();
  }
});
test("Run metadata/off privacy redacts prompts and secrets; restart marks interrupted runs, no implicit resumption", async () => {
  const f = await intentFixture();
  const unregister = registerProvider(
    "fixture-provider",
    () =>
      new MockAdapter(async (req) =>
        single(JSON.parse(req.messages[1].content).userRequest),
      ),
  );
  try {
    const secret = "куар снизу с фейдом secret-user-prompt-123";
    await executeMotion(f.project, await input(f, secret), () => {}, {
      config: { privacy: "metadata" },
    });
    const all = JSON.stringify(await readRuns(f.project.root));
    assert.ok(!all.includes(secret));
    assert.ok(
      !JSON.stringify((await readMotion(f.project)).history).includes(secret),
    );
    assert.ok(
      !JSON.stringify(
        redact({
          apiKey: "sk-abcdef12345678901234",
          text: "Bearer abcdefghijklmnop",
        }),
      ).includes("abcdef"),
    );
    const run = await HarnessRun.start(
      f.project,
      randomUUID(),
      "synthetic",
      "fixture-provider",
      "",
    );
    await run.finish("FAILED");
    const file = path.join(
      f.project.root,
      "motion/harness/runs",
      run.runId,
      "run.json",
    );
    const raw = JSON.parse(await readFile(file, "utf8"));
    raw.status = "RUNNING";
    raw.ownerPid = -1;
    await writeFile(file, JSON.stringify(raw));
    await recoverInterruptedRuns(f.project.root);
    assert.equal(
      (await readRuns(f.project.root)).find((r) => r.runId === run.runId)
        ?.status,
      "INTERRUPTED",
    );
    const count = (await readRuns(f.project.root)).length;
    await executeMotion(f.project, await input(f, secret + " off"), () => {}, {
      config: { privacy: "off" },
    });
    assert.equal((await readRuns(f.project.root)).length, count);
  } finally {
    unregister();
    await f.cleanup();
  }
});
test("Persistent experience retrieval, repeated-failure candidates, isolated eval comparison rejects regression, never modifies production knowledge", async () => {
  const f = await intentFixture();
  try {
    for (let i = 0; i < 2; i++)
      await saveExperience(f.project.root, {
        runId: randomUUID(),
        createdAt: new Date().toISOString(),
        status: "FAILED",
        request: "Trim Paths QR",
        techniques: ["trimPath"],
        failures: ["MISSING_PATH_GEOMETRY"],
        repairs: 1,
        objectiveQA: "FAILED",
        artisticQuality: "NOT_TESTED",
        versions: [],
      });
    assert.equal(
      (await experienceSearch(f.project.root, "Trim Paths", ["trimPath"], 1))
        .length,
      1,
    );
    const [c] = await collectImprovements(f.project.root);
    assert.ok(c.failedRuns.length === 2);
    assert.equal((await collectImprovements(f.project.root)).length, 0);
    let iteration = 0;
    const result = await evaluateCandidate(f.project.root, c.id, async () => ({
      providerMode: "live",
      results: [
        { evalId: "trim", status: ++iteration === 1 ? "PASSED" : "FAILED" },
      ],
      metrics: {},
      datasetVersion: "fixture-v1",
    }));
    assert.equal(result.status, "REJECTED");
    assert.equal(result.versionHistory.length, 1);
    assert.equal(
      regressionComparison([{ evalId: "a", status: "PASSED" }], [])
        .regressionRate,
      1,
    );
    assert.equal(harnessMetrics([]).finalSuccessRate, null);
  } finally {
    await f.cleanup();
  }
});
test("Single-pass semantic plan uses no independent audit in normal execution; malformed coverage repairs only on failure", async () => {
  const f = await intentFixture();
  try {
    let calls = 0;
    const plan = await semanticPlan(
      f.project,
      compositeRequest,
      {},
      {
        interpret: async () => {
          calls++;
          return f.plan;
        },
        audit: async () => {
          throw new Error("Unnecessary second call");
        },
      },
      async () => {},
      { auditAlways: false },
    );
    assert.equal(calls, 1);
    assert.equal(plan.requirements.length, 10);
  } finally {
    await f.cleanup();
  }
});

test("QA cache reuses genuine rendered report and invalidates knowledge versions without stale samples", async () => {
  const { RunQA } = await import("../src/harness/qa.js");
  const { compileTasks, compileRequirement } = await import(
    "../src/motion/intent/compiler.js"
  );
  const { applyOperations } = await import("../src/motion/operations.js");
  const f = await intentFixture();
  const run = await HarnessRun.start(
    f.project,
    randomUUID(),
    "synthetic cache fixture",
    "fixture-provider",
    "",
  );
  const qa = new RunQA(run);
  try {
    const before = (await readMotion(f.project)).state,
      plan = single("куар снизу с фейдом и инерцией"),
      task = compileTasks(f.project, plan)[0];
    const operations = compileRequirement(f.project, before, plan, task),
      next = applyOperations(before, operations.operations, f.project);
    const first = await qa.verify(task, next, before, 1);
    assert.notEqual(first.status, "FAILED");
    const rendered = run.renderedFrames;
    assert.ok(rendered > 0);
    const reused = await qa.verify(task, next, before, 2);
    assert.equal("cacheHit" in reused && reused.cacheHit, true);
    assert.equal(run.renderedFrames, rendered);
    assert.ok(
      (
        await readdir(
          path.join(
            f.project.root,
            "motion/qa",
            run.runId,
            task.taskId + "-attempt-2",
          ),
        )
      ).includes("report.json"),
    );
    run.references = [
      { id: "numericQA", version: "changed-for-invalidation-test" },
    ];
    await qa.verify(task, next, before, 3);
    assert.ok(run.renderedFrames > rendered);
  } finally {
    await qa.close();
    await run.finish("SUCCESS");
    await f.cleanup();
  }
});

test("Identical semantic failure stops retry and mock improvement cannot receive acceptance", async () => {
  const f = await intentFixture();
  try {
    let calls = 0;
    await assert.rejects(
      semanticPlan(
        f.project,
        "synthetic",
        {},
        {
          interpret: async () => {
            calls++;
            throw new Error("SAME_INVALID_TARGET");
          },
          audit: async () => {
            throw new Error("unused");
          },
        },
        async () => {},
        { auditAlways: false, maxAttempts: 3 },
      ),
      /SAME_INVALID_TARGET/,
    );
    assert.equal(calls, 2);
    for (let i = 0; i < 2; i++)
      await saveExperience(f.project.root, {
        runId: randomUUID(),
        createdAt: new Date().toISOString(),
        status: "FAILED",
        techniques: [],
        failures: ["SYNTHETIC_FAILURE"],
        repairs: 0,
        objectiveQA: "NOT_TESTED",
        artisticQuality: "NOT_TESTED",
        versions: [],
      });
    const [candidate] = await collectImprovements(f.project.root);
    let n = 0;
    const result = await evaluateCandidate(
      f.project.root,
      candidate.id,
      async () => ({
        providerMode: "mock",
        complete: true,
        datasetVersion: "same",
        metrics: {},
        results: [
          { evalId: "fixture", status: ++n === 1 ? "FAILED" : "PASSED" },
        ],
      }),
    );
    assert.equal(result.status, "INCONCLUSIVE");
  } finally {
    await f.cleanup();
  }
});
