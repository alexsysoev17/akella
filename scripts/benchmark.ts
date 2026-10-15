import { benchmarkSummary, writeBenchmarkReport } from "./benchmark-report.ts";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  runAgentEvals,
  evalDatasetSchema,
} from "../apps/scene-validator/src/harness/evals.ts";
import { registerProvider } from "../apps/scene-validator/src/harness/providers/index.ts";
import { codeVersions } from "../apps/scene-validator/src/harness/versions.ts";
import { normalizeSemanticGraph } from "../apps/scene-validator/src/motion/intent/graph.ts";
import { evalFixture } from "./harness-fixtures.ts";
const args = process.argv.slice(2),
  arg = (id: string, fallback?: string) => {
    const i = args.indexOf("--" + id);
    return i < 0 ? fallback : args[i + 1];
  };
const datasetPath = arg("dataset", "harness/evals/benchmark.json")!,
  dataset = evalDatasetSchema.parse(
    JSON.parse(await readFile(datasetPath, "utf8")),
  );
const live = args.includes("--live"),
  provider = live ? arg("provider", "codex-sdk")! : "benchmark-reference";
let current = dataset.cases[0];
function nativeWire(value: unknown, schema: unknown, root = schema): unknown {
  if (!schema || typeof schema !== "object") return value;
  const s = schema as Record<string, unknown>;
  if (typeof s.$ref === "string") {
    let r: unknown = root;
    for (const part of s.$ref.slice(2).split("/"))
      r = (r as Record<string, unknown>)[part];
    return nativeWire(value, r, root);
  }
  if (
    Array.isArray(s.anyOf) &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    for (const branch of s.anyOf) {
      const candidate = branch as Record<string, unknown>;
      if (candidate.type === "object" || candidate.$ref)
        return nativeWire(value, candidate, root);
    }
  }
  if (Array.isArray(value) && s.items)
    return value.map((v) => nativeWire(v, s.items, root));
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    s.properties
  ) {
    const properties = s.properties as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(properties).map(([k, prop]) => [
        k,
        k in value
          ? nativeWire((value as Record<string, unknown>)[k], prop, root)
          : null,
      ]),
    );
  }
  return value;
}
const unregister = live
  ? () => {}
  : registerProvider(provider, () => ({
      id: provider,
      mode: "mock",
      capabilities: () => ({
        structuredOutput: true,
        nativeToolCalling: false,
        cancellation: true,
        usage: false,
        nativeOutputTokenLimit: false,
      }),
      generate: async (request) => {
        const payload = JSON.parse(request.messages[1].content);
        const reference =
          current.turns?.find((t) => t.prompt === payload.userRequest)
            ?.referenceOutput ?? current.referenceOutput;
        const normalized = normalizeSemanticGraph(
          reference,
          payload.context,
          payload.userRequest,
        );
        const compact = {
          ...normalized,
          requirements: normalized.requirements.map((r) => ({
            ...r,
            temporalReference: r.timing.reference ?? null,
            delayFrames:
              r.timing.offsetFrames ??
              Math.round(
                r.timing.delaySeconds * (payload.context.project?.fps ?? 30),
              ),
            startFrame:
              r.timing.startSeconds === null
                ? null
                : Math.round(
                    r.timing.startSeconds *
                      (payload.context.project?.fps ?? 30),
                  ),
            timingRelation: ["sceneStart", "sceneEnd", "unchanged"].includes(
              r.timing.relation,
            )
              ? r.timing.relation
              : null,
          })),
        };
        return {
          output: nativeWire(
            (
              request.responseSchema as {
                properties?: { schemaVersion?: { const?: string } };
              }
            ).properties?.schemaVersion?.const === "1.0.0"
              ? compact
              : reference,
            request.responseSchema,
          ),
          usage: null,
          estimatedCost: null,
          latencyMs: 0,
          diagnostics: [
            "reference semantic graph fixture; semantic model accuracy NOT_TESTED",
          ],
          toolCalls: [],
        };
      },
    }));
const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  versions = await codeVersions();
const output = arg(
  "output",
  `artifacts/harness/benchmark/${commit}/${Date.now()}.json`,
)!;
try {
  const result = await runAgentEvals({
    dataset: datasetPath,
    output,
    provider,
    model: arg("model", ""),
    fixture: evalFixture,
    keepFixtures: args.includes("--keep-fixtures"),
    verifyVideo: args.includes("--video"),
    caseIds: arg("cases")?.split(","),
    config: { maxLLMCalls: 1, maxRepairAttempts: 0 },
    onCase: (id, status) => {
      current = dataset.cases.find((c) => c.evalId === id)!;
      console.log(id, status);
    },
  });
  const passed = result.results.filter((r) => r.status === "PASSED").length;
  const previous = arg("baseline")
    ? JSON.parse(await readFile(arg("baseline")!, "utf8"))
    : null;
  const comparable =
    previous?.datasetVersion === result.datasetVersion &&
    previous?.providerMode === result.providerMode &&
    previous?.provider === result.provider &&
    previous?.model === result.model;
  const regressions = comparable
    ? result.results
        .filter(
          (r) =>
            r.status === "FAILED" &&
            previous.results.some(
              (old: { evalId: string; status: string }) =>
                old.evalId === r.evalId && old.status === "PASSED",
            ),
        )
        .map((r) => r.evalId)
    : null;
  const report = {
    ...result,
    gitCommit: commit,
    workingTree: execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
    }).trim()
      ? "DIRTY"
      : "CLEAN",
    versions,
    measurements: benchmarkSummary(result),
    benchmark: {
      cases: result.results.length,
      passed,
      failed: result.results.length - passed,
      casePassRate: passed / result.results.length,
      semanticAccuracy: live ? null : "NOT_TESTED_REFERENCE_FIXTURES",
      artisticCorrectness: "NOT_TESTED",
      regressions,
      baselineComparison: comparable ? "COMPARABLE" : "NO_COMPARABLE_BASELINE",
    },
  };
  await writeFile(output, JSON.stringify(report, null, 2));
  await writeBenchmarkReport(output);
  console.log(JSON.stringify({ output, ...report.benchmark }, null, 2));
  if (passed !== result.results.length) process.exitCode = 1;
} finally {
  unregister();
}
