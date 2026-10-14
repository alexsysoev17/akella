import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
export interface BenchmarkData {
  providerMode: string;
  results: {
    evalId: string;
    status: string;
    expectedOutcome?: string;
    stages?: Record<string, string>;
    llmCalls: number;
    turnCount?: number;
    performance?: unknown[];
    videoQA?: unknown;
  }[];
}
export function benchmarkSummary(data: BenchmarkData) {
  const supported = data.results.filter((r) => r.expectedOutcome !== "REJECT"),
    rejections = data.results.filter((r) => r.expectedOutcome === "REJECT");
  const rate = (
    rows: BenchmarkData["results"],
    predicate: (r: BenchmarkData["results"][number]) => boolean,
  ) => (rows.length ? rows.filter(predicate).length / rows.length : null);
  const stage = (name: string) => {
    const rows = supported.filter(
      (r) =>
        !["NOT_TESTED", "NOT_TESTED_MOCK", "NOT_COMPLETED", undefined].includes(
          r.stages?.[name],
        ),
    );
    return {
      measured: rows.length,
      passRate: rate(
        rows,
        (r) =>
          r.stages?.[name] === "PASSED" ||
          r.stages?.[name] === "PASSED_NO_STATE_DIFF",
      ),
    };
  };
  const performance = data.results.map(
    (r) =>
      (r.performance ?? []).filter((x) => x && typeof x === "object") as Record<
        string,
        unknown
      >[],
  );
  const latency = performance
    .map((rows) =>
      rows.reduce(
        (n, r) => n + (typeof r.latencyMs === "number" ? r.latencyMs : 0),
        0,
      ),
    )
    .sort((a, b) => a - b);
  const percentile = (p: number) =>
    latency.length
      ? latency[Math.max(0, Math.ceil(p * latency.length) - 1)]
      : null;
  const measuredTokens = performance
    .flat()
    .filter(
      (r) =>
        r.usage &&
        typeof r.usage === "object" &&
        (r.usage as { inputTokens?: number }).inputTokens! > 0,
    );
  return {
    scenarioCount: data.results.length,
    supportedScenarioCount: supported.length,
    expectedRejectionCount: rejections.length,
    casePassRate: rate(data.results, (r) => r.status === "PASSED"),
    supportedTaskSuccessRate: rate(supported, (r) => r.status === "PASSED"),
    safetyRejectionPassRate: rate(rejections, (r) => r.status === "PASSED"),
    semantic:
      data.providerMode === "mock"
        ? {
            measured: 0,
            passRate: null,
            reason: "REFERENCE_PLAN_FIXTURES_DO_NOT_MEASURE_LLM_SEMANTICS",
          }
        : stage("semantic"),
    compilation: stage("compilation"),
    execution: stage("execution"),
    visualTechnicalQA: stage("visual"),
    artisticQA: "NOT_TESTED",
    latencyMs: {
      median: percentile(0.5),
      p95: percentile(0.95),
      mode:
        data.providerMode === "mock"
          ? "LOCAL_FIXTURE_EXECUTION_NOT_LIVE_LATENCY"
          : "LIVE",
    },
    providerFixtureCalls:
      data.providerMode === "mock"
        ? data.results.reduce((n, r) => n + r.llmCalls, 0)
        : 0,
    liveLLMCalls:
      data.providerMode === "live"
        ? data.results.reduce((n, r) => n + r.llmCalls, 0)
        : 0,
    providerCallsPerUserTurn:
      data.results.reduce((n, r) => n + r.llmCalls, 0) /
      data.results.reduce((n, r) => n + (r.turnCount ?? 1), 0),
    tokenUsage:
      data.providerMode === "mock" || !measuredTokens.length
        ? null
        : {
            measuredRuns: measuredTokens.length,
            input: measuredTokens.reduce(
              (n, r) =>
                n + Number((r.usage as { inputTokens: number }).inputTokens),
              0,
            ),
            output: measuredTokens.reduce(
              (n, r) =>
                n + Number((r.usage as { outputTokens: number }).outputTokens),
              0,
            ),
          },
    estimatedCost:
      performance.flat().length &&
      performance.flat().every((r) => typeof r.estimatedCost === "number")
        ? performance.flat().reduce((n, r) => n + Number(r.estimatedCost), 0)
        : null,
  };
}
export async function writeBenchmarkReport(
  input: string,
  output = input.replace(/\.json$/, ".html"),
) {
  const data = JSON.parse(await readFile(input, "utf8")) as BenchmarkData & {
    gitCommit?: string;
  };
  const summary = benchmarkSummary(data);
  const esc = (value: unknown) =>
    String(value).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c]!,
    );
  await writeFile(
    output,
    `<!doctype html><meta charset="utf-8"><title>AKELLA benchmark</title><style>body{font:15px system-ui;margin:40px;max-width:1100px}td,th{padding:8px;text-align:left}pre{white-space:pre-wrap}</style><h1>AKELLA benchmark</h1><p>${esc(data.providerMode)} · ${esc(data.gitCommit ?? "unknown commit")}</p><pre>${esc(JSON.stringify(summary, null, 2))}</pre><table><tr><th>Scenario</th><th>Status</th><th>Stages</th></tr>${data.results.map((r) => `<tr><td>${esc(r.evalId)}</td><td>${esc(r.status)}</td><td>${esc(JSON.stringify(r.stages))}</td></tr>`).join("")}</table><p>Reference fixtures do not establish production natural-language accuracy. Visual technical QA is separate from artistic quality. No live cost is assumed when unavailable.</p>`,
  );
  return { output, summary };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2),
    i = args.indexOf("--input");
  if (i < 0) throw new Error("--input REPORT.json required");
  console.log(JSON.stringify(await writeBenchmarkReport(args[i + 1]), null, 2));
}
