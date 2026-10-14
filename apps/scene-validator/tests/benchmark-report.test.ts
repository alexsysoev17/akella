import test from "node:test";
import assert from "node:assert/strict";
import { benchmarkSummary } from "../../../scripts/benchmark-report.ts";
test("benchmark separates expected rejection, technical success, warning and unmeasured semantics/cost", () => {
  const summary = benchmarkSummary({
    providerMode: "mock",
    results: [
      {
        evalId: "a",
        status: "PASSED",
        expectedOutcome: "SUCCESS",
        llmCalls: 1,
        turnCount: 1,
        stages: {
          semantic: "NOT_TESTED_MOCK",
          compilation: "PASSED",
          execution: "PASSED",
          visual: "WARNING_OR_FAILED",
        },
        performance: [{ latencyMs: 100, usage: null, estimatedCost: null }],
      },
      {
        evalId: "b",
        status: "PASSED",
        expectedOutcome: "REJECT",
        llmCalls: 1,
        stages: { visual: "NOT_TESTED" },
        performance: [{ latencyMs: 20 }],
      },
    ],
  });
  assert.equal(summary.supportedTaskSuccessRate, 1);
  assert.equal(summary.safetyRejectionPassRate, 1);
  assert.equal(summary.visualTechnicalQA.passRate, 0);
  assert.equal(summary.semantic.passRate, null);
  assert.equal(summary.tokenUsage, null);
  assert.equal(summary.estimatedCost, null);
  assert.equal(summary.liveLLMCalls, 0);
  assert.equal(summary.providerFixtureCalls, 2);
});
