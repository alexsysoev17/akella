import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { experiences } from "./experience.js";
import { atomicJson, noSymlinkPath, safeDirectory } from "../files.js";
import { regressionComparison } from "./metrics.js";
import type { HarnessConfig } from "./config.js";
export interface ImprovementCandidate {
  schemaVersion: "1.0.0";
  id: string;
  createdAt: string;
  problem: string;
  failedRuns: string[];
  component: string;
  patch: Partial<Pick<HarnessConfig, "extraGuidance" | "retrievalBoosts">>;
  status: "PROPOSED" | "REJECTED" | "INCONCLUSIVE" | "ACCEPTED_FOR_REVIEW";
  baselineMetrics: unknown;
  candidateMetrics: unknown;
  evaluationResults: unknown;
  versionHistory: unknown[];
}
export async function collectImprovements(root: string) {
  const grouped = new Map<string, string[]>();
  for (const e of await experiences(root))
    for (const failure of new Set(e.failures)) {
      const ids = grouped.get(failure) ?? [];
      ids.push(e.runId);
      grouped.set(failure, ids);
    }
  const dir = await safeDirectory(root, "motion/harness/improvements");
  const existing = await candidates(root);
  const added: ImprovementCandidate[] = [];
  for (const [problem, ids] of grouped) {
    if (ids.length < 2 || existing.some((c) => c.problem === problem)) continue;
    const trim = /PATH|GEOMETRY|TRIM|QA/i.test(problem);
    const candidate: ImprovementCandidate = {
      schemaVersion: "1.0.0",
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      problem,
      failedRuns: ids,
      component: trim ? "capability-retrieval" : "intent-context",
      patch: {
        extraGuidance: [
          trim
            ? "Inspect path capability and exact renderer diagnostics before choosing trimPath. Never substitute scale."
            : "Preserve every linked intent component and inspect actual target IDs before generating operations.",
        ],
        retrievalBoosts: trim ? ["trimPath"] : [],
      },
      status: "PROPOSED",
      baselineMetrics: null,
      candidateMetrics: null,
      evaluationResults: null,
      versionHistory: [],
    };
    await atomicJson(path.join(dir, candidate.id + ".json"), candidate);
    added.push(candidate);
  }
  return added;
}
export async function candidates(
  root: string,
): Promise<ImprovementCandidate[]> {
  const dir = path.join(root, "motion/harness/improvements");
  try {
    await noSymlinkPath(root, dir);
    const files = (await readdir(dir)).filter((f) =>
      /^[a-f0-9-]{36}\.json$/.test(f),
    );
    return await Promise.all(
      files.map(async (f) => {
        const file = path.join(dir, f);
        await noSymlinkPath(root, file);
        return JSON.parse(await readFile(file, "utf8"));
      }),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
export async function evaluateCandidate(
  root: string,
  id: string,
  run: (
    patch: ImprovementCandidate["patch"],
  ) => Promise<{
    providerMode: "live" | "mock";
    complete?: boolean;
    results: { evalId: string; status: string }[];
    metrics: unknown;
    datasetVersion: string;
  }>,
) {
  const candidate = (await candidates(root)).find((c) => c.id === id);
  if (!candidate) throw new Error("Unknown candidate");
  const baseline = await run({}),
    tested = await run(candidate.patch),
    comparison = regressionComparison(baseline.results, tested.results);
  const same = baseline.datasetVersion === tested.datasetVersion;
  const improved =
    tested.results.filter((e) => e.status === "PASSED").length >
    baseline.results.filter((e) => e.status === "PASSED").length;
  const accepted =
    baseline.providerMode === "live" &&
    tested.providerMode === "live" &&
    baseline.complete === true &&
    tested.complete === true &&
    same &&
    !comparison.regressions.length &&
    !comparison.missing.length &&
    improved;
  const status: ImprovementCandidate["status"] =
    comparison.regressions.length || !same
      ? "REJECTED"
      : accepted
        ? "ACCEPTED_FOR_REVIEW"
        : "INCONCLUSIVE";
  const next = {
    ...candidate,
    status,
    baselineMetrics: baseline.metrics,
    candidateMetrics: tested.metrics,
    evaluationResults: {
      baseline: baseline.results,
      candidate: tested.results,
      comparison,
      providerMode: tested.providerMode,
      datasetVersion: tested.datasetVersion,
    },
    versionHistory: [
      ...candidate.versionHistory,
      {
        at: new Date().toISOString(),
        previousStatus: candidate.status,
        status,
        patch: candidate.patch,
      },
    ],
  };
  await atomicJson(
    path.join(root, "motion/harness/improvements", id + ".json"),
    next,
  );
  return next;
}
// No production code or knowledge writes: candidates are tested through isolated config overlays only.
