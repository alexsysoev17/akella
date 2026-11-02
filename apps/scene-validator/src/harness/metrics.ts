export interface MetricRun {
  status: string;
  executionRole?:string;
  productionId?:string;
  createdAt?:string;
  calls?: { mode?: string }[];
  metrics?: {
    latencyMs?: number;
    llmCalls?: number;
    repairAttempts?: number;
    estimatedCost?: number | null;
    usage?: { inputTokens: number; outputTokens: number } | null;
  };
  outcome?: { techniqueChecks?: { passed: number; total: number } };
}
const rate = (n: number, d: number) => (d ? n / d : null);
const percentile = (values: number[], p: number) =>
  values.length
    ? [...values].sort((a, b) => a - b)[
        Math.max(0, Math.ceil(values.length * p) - 1)
      ]
    : null;
export function harnessMetrics(input: MetricRun[], includeMocks = false) {
  const latest=new Map<string,MetricRun>();for(const r of input)if(r.executionRole==='production'&&r.productionId){const old=latest.get(r.productionId);if(!old||String(r.createdAt??'')>String(old.createdAt??''))latest.set(r.productionId,r);}
  const rows = input.filter(
      (r) =>
        r.status !== "RUNNING" && r.status!=='HANDOFF' && r.executionRole!=='worker' && (r.executionRole!=='production'||!r.productionId||latest.get(r.productionId)===r) &&
        (includeMocks || r.calls?.some((c) => c.mode === "live")),
    ),
    ok = rows.filter((r) => r.status === "SUCCESS"),
    repaired = rows.filter(
      (r) =>
        (r.executionRole!=='production'&&(r.metrics?.llmCalls ?? 0) > 1) || (r.metrics?.repairAttempts ?? 0) > 0,
    ),
    first = ok.filter(
      (r) =>
        typeof r.metrics?.llmCalls === "number" && (r.executionRole==='production'||r.metrics.llmCalls <= 1) && !(r.metrics?.repairAttempts ?? 0),
    );
  const latency = rows
    .map((r) => r.metrics?.latencyMs)
    .filter((v): v is number => typeof v === "number");
  const total = rows.reduce(
      (n, r) => n + (r.outcome?.techniqueChecks?.total ?? 0),
      0,
    ),
    passed = rows.reduce(
      (n, r) => n + (r.outcome?.techniqueChecks?.passed ?? 0),
      0,
    );
  return {
    sampleCount: rows.length,
    mockResultsIncluded: includeMocks,
    firstPassSuccessRate: rate(first.length, rows.length),
    finalSuccessRate: rate(ok.length, rows.length),
    techniqueAccuracy: rate(passed, total),
    repairSuccessRate: rate(
      repaired.filter((r) => r.status === "SUCCESS").length,
      repaired.length,
    ),
    latency: {
      medianMs: percentile(latency, 0.5),
      p95Ms: percentile(latency, 0.95),
    },
    llmCalls: rows.reduce((n, r) => n + (r.metrics?.llmCalls ?? 0), 0),
    tokens:
      rows.length && rows.every((r) => r.metrics?.usage)
        ? {
            input: rows.reduce((n, r) => n + r.metrics!.usage!.inputTokens, 0),
            output: rows.reduce(
              (n, r) => n + r.metrics!.usage!.outputTokens,
              0,
            ),
          }
        : null,
    estimatedCost:
      rows.length &&
      rows.every((r) => typeof r.metrics?.estimatedCost === "number")
        ? rows.reduce((n, r) => n + r.metrics!.estimatedCost!, 0)
        : null,
    artisticQuality: "NOT_TESTED",
  };
}
export function regressionComparison(
  baseline: { evalId: string; status: string }[],
  candidate: { evalId: string; status: string }[],
) {
  const prior = baseline.filter((e) => e.status === "PASSED");
  const regressions = prior
    .filter(
      (e) => candidate.find((c) => c.evalId === e.evalId)?.status !== "PASSED",
    )
    .map((e) => e.evalId);
  return {
    regressions,
    regressionRate: rate(regressions.length, prior.length),
    missing: baseline
      .filter((e) => !candidate.some((c) => c.evalId === e.evalId))
      .map((e) => e.evalId),
  };
}
