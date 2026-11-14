import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  utimes,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { providerBudget } from "../src/harness/providers/budget.js";
import type {
  ProviderAdapter,
  ProviderRequest,
} from "../src/harness/providers/types.js";
import {
  modelQualification,
  qualificationCases,
} from "../src/harness/qualification.js";
import { providerStatus, plannerInstructions } from "../src/motion/provider.js";
import { registerProvider } from "../src/harness/providers/index.js";
import { capabilityGuidance } from "../src/motion-library/guidance.js";
import { capabilityCatalog } from "../src/motion-library/registry/capabilities.js";
import { semanticBindings } from "../src/motion-library/techniques/registry.js";
import { semanticContext } from "../src/motion/intent/planner.js";
import {
  inventory,
  inventoryMetrics,
  resetInventoryMetrics,
} from "../src/files.js";
import { identityFixture } from "./identity-fixture.js";
import {
  readMotion,
  changeMotion,
  archiveMotionHistory,
} from "../src/motion/store.js";
const adapter: ProviderAdapter = {
  id: "fixture",
  mode: "mock",
  capabilities: () => ({
    structuredOutput: true,
    nativeToolCalling: false,
    cancellation: true,
    usage: false,
    nativeOutputTokenLimit: false,
  }),
  generate: async () => {
    throw Error("no calls expected");
  },
};
const request: ProviderRequest = {
  messages: [{ role: "user", content: "hello" }],
  responseSchema: { type: "object" },
  timeoutMs: 1000,
  maxOutputTokens: 1000,
  model: "small",
};
test("full request budget includes schema/tools and model reserve; tokenizer/profile never silently truncates", () => {
  assert.throws(
    () =>
      providerBudget(
        adapter,
        { ...request, responseSchema: { description: "x".repeat(6000) } },
        4000,
      ),
    /CONTEXT_EXHAUSTED/,
  );
  assert.throws(
    () =>
      providerBudget(
        adapter,
        {
          ...request,
          tools: [
            { name: "tool", description: "x".repeat(6000), parameters: {} },
          ],
        },
        4000,
      ),
    /CONTEXT_EXHAUSTED/,
  );
  const profile = {
    provider: "fixture",
    model: "small",
    contextWindowTokens: 200,
    maxOutputTokens: 100,
    transportOverheadTokens: 50,
  };
  assert.throws(
    () => providerBudget(adapter, request, 10000, [profile]),
    /CONTEXT_EXHAUSTED/,
  );
  const ok = providerBudget(
    { ...adapter, estimateInputTokens: () => 40 },
    request,
    10000,
    [profile],
  );
  assert.equal(ok.outputTokens, 100);
  assert.equal(ok.estimateMethod, "adapter-tokenizer");
  assert.equal(request.maxOutputTokens, 1000);
  assert.equal(
    providerBudget(adapter, { ...request, model: "other" }, 10000, [profile])
      .profileStatus,
    "UNKNOWN_MODEL_CONSERVATIVE",
  );
});
test("provider health follows registered adapter and missing health stays UNKNOWN without Codex probe", async () => {
  const stop = registerProvider("fixture", () => ({
    ...adapter,
    health: async () => ({
      status: "AUTH_REQUIRED",
      message: "fixture auth required",
    }),
  }));
  try {
    assert.equal(
      (await providerStatus({ provider: "fixture", model: "small" })).status,
      "AUTH_REQUIRED",
    );
  } finally {
    stop();
  }
  const unknown = registerProvider("fixture", () => adapter);
  try {
    assert.equal(
      (await providerStatus({ provider: "fixture", model: "small" })).status,
      "UNKNOWN",
    );
  } finally {
    unknown();
  }
});
test("qualification rejects mocks, missing cases, unpinned models and failed rendering", () => {
  const report = {
    providerMode: "live",
    model: "pinned-model",
    results: qualificationCases.map((evalId) => ({
      evalId,
      status: "PASSED",
      stages: {
        semantic: "PASSED",
        compilation: "PASSED",
        execution: "PASSED",
        visual: "PASSED",
      },
    })),
  };
  assert.equal(
    modelQualification(report).status,
    "QUALIFIED_FOR_TESTED_WORKFLOWS",
  );
  for (const altered of [
    { ...report, providerMode: "mock" },
    { ...report, model: "" },
    { ...report, results: report.results.slice(1) },
    {
      ...report,
      results: report.results.map((r, i) =>
        i ? r : { ...r, stages: { ...r.stages, visual: "WARNING" } },
      ),
    },
  ])
    assert.equal(modelQualification(altered).status, "NOT_QUALIFIED");
});
test("shared capability guidance preserves text support and no-substitution policy; compact catalog lossless for type sets", () => {
  assert.doesNotMatch(
    plannerInstructions,
    /choose whole-text reveal|nearest valid container|nearest supported easing/,
  );
  assert.match(capabilityGuidance(), /block\/line\/word\/character/);
  assert.match(capabilityGuidance(), /never approximated/);
  const catalog = capabilityCatalog();
  for (const [id, kind] of Object.entries(semanticBindings))
    assert.ok(
      catalog.some((c) => c.kind === kind && c.semanticTechniques.includes(id)),
      id,
    );
  const context = semanticContext({
    motionKnowledge: { capabilities: catalog },
  }) as {
    motionKnowledge: {
      capabilities: { id: string; objectTypesRef: string }[];
      capabilityObjectTypes: Record<string, unknown>;
    };
  };
  for (const c of catalog) {
    const compact = context.motionKnowledge.capabilities.find(
      (r) => r.id === c.id,
    )!;
    assert.deepEqual(
      context.motionKnowledge.capabilityObjectTypes[compact.objectTypesRef],
      c.supportedObjectTypes,
    );
  }
  assert.ok(
    JSON.stringify(context).length <
      JSON.stringify({ motionKnowledge: { capabilities: catalog } }).length,
  );
});
test("streamed 32 MiB inventory reuses hashes, invalidates edits even with restored mtime, strict verification still hashes", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "source-inventory-"));
  try {
    const chunk = Buffer.alloc(1024 * 1024, 17);
    for (let i = 0; i < 32; i++)
      await writeFile(path.join(root, `asset${i}.bin`), chunk);
    resetInventoryMetrics();
    const start = performance.now();
    const cold = await inventory(root, { reuseHashes: true });
    const coldMs = performance.now() - start;
    assert.equal(inventoryMetrics.bytesHashed, 32 * 1024 * 1024);
    resetInventoryMetrics();
    const warmStart = performance.now();
    assert.deepEqual(await inventory(root, { reuseHashes: true }), cold);
    const warmMs = performance.now() - warmStart;
    assert.equal(inventoryMetrics.bytesHashed, 0);
    assert.equal(inventoryMetrics.cacheHits, 32);
    const originalStat = await stat(path.join(root, "asset0.bin"));
    await writeFile(
      path.join(root, "asset0.bin"),
      Buffer.alloc(1024 * 1024, 18),
    );
    await utimes(
      path.join(root, "asset0.bin"),
      originalStat.atime,
      originalStat.mtime,
    );
    assert.notDeepEqual(await inventory(root, { reuseHashes: true }), cold);
    resetInventoryMetrics();
    await inventory(root);
    assert.equal(inventoryMetrics.bytesHashed, 32 * 1024 * 1024);
    t.diagnostic(
      JSON.stringify({
        coldMs,
        warmMs,
        sourceBytes: 32 * 1024 * 1024,
        warmBytesHashed: 0,
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("explicit history archiving preserves full archive, current state and remaining Undo/Redo", async () => {
  const f = await identityFixture(1);
  try {
    let doc = await readMotion(f.project);
    for (let i = 0; i < 5; i++)
      doc = (
        await changeMotion(f.project.root, {
          expectedRevision: doc.revision,
          request: "fixture",
          operations: [
            {
              type: "setProjectSettings",
              settings: { ...doc.state.settings, fps: 20 + i },
            },
          ],
        })
      ).document;
    const original = await readMotion(f.project);
    const result = await archiveMotionHistory(
      f.project.root,
      original.revision,
      2,
    );
    assert.ok(result.archived);
    const current = await readMotion(f.project);
    assert.deepEqual(current.state, original.state);
    assert.equal(current.history.length, 2);
    assert.equal(current.cursor, 2);
    const archive = JSON.parse(
      await readFile(path.join(f.project.root, result.archive!), "utf8"),
    );
    assert.deepEqual(archive, original);
    const undo = await changeMotion(f.project.root, {
      expectedRevision: current.revision,
      action: "undo",
      request: "undo",
    });
    const redo = await changeMotion(f.project.root, {
      expectedRevision: undo.document.revision,
      action: "redo",
      request: "redo",
    });
    assert.deepEqual(redo.document.state, original.state);
    await assert.rejects(
      archiveMotionHistory(f.project.root, original.revision, 1),
      /STALE_PROJECT_REVISION/,
    );
  } finally {
    await f.cleanup();
  }
});

import { transportErrorCode } from "../src/harness/providers/types.js";
test("transport errors preserve actionable categories without inferred retries", () => {
  for (const [status, code] of [
    [401, "AUTH_REQUIRED"],
    [429, "RATE_LIMITED"],
    [503, "OVERLOADED"],
    [504, "TIMEOUT"],
  ] as const)
    assert.equal(transportErrorCode({ status }), code);
  assert.equal(
    transportErrorCode({ code: "context_length_exceeded" }),
    "CONTEXT_EXHAUSTED",
  );
  assert.equal(transportErrorCode(Error("unknown")), "TRANSPORT");
});

import {mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {inspectorRun} from '../src/harness/inspector.js';
test('Inspector retains historical commit evidence when canonical history exceeds diagnostic read cap',async()=>{
 const f=await identityFixture(1);try{
  const before=await readMotion(f.project),id=randomUUID();
  const changed=await changeMotion(f.project.root,{expectedRevision:before.revision,transactionId:id,request:'fixture',operations:[{type:'setProjectSettings',settings:{...before.state.settings,fps:24}}]});
  changed.document.history[0].request='x'.repeat(5*1024*1024);
  await writeFile(path.join(f.project.root,'motion/motion.json'),JSON.stringify(changed.document));
  const run=path.join(f.project.root,'motion/harness/runs',id),ai=path.join(f.project.root,'motion/ai',id);await mkdir(run,{recursive:true});await mkdir(ai,{recursive:true});
  await writeFile(path.join(run,'run.json'),JSON.stringify({runId:id,privacy:'full',status:'SUCCESS',calls:[]}));
  await writeFile(path.join(ai,'commit-receipt.json'),JSON.stringify({runId:id,status:'COMMITTED',receipt:changed.document.lastCommit}));
  const result=await inspectorRun(f.project.root,id) as {commitEvidence:{status:string;currentEffectiveState:string}};
  assert.equal(result.commitEvidence.status,'HISTORICAL_COMMIT_RECEIPT');assert.equal(result.commitEvidence.currentEffectiveState,'NOT_CONFIRMED');
 }finally{await f.cleanup();}
});
