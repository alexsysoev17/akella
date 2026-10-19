/** Developer admission suite. Never run paid evaluation during an ordinary user request. */
export const qualificationCases = [
  "NEW_01",
  "NEW_09_COMPOUND",
  "WORKFLOW_01_SEQUENCE",
  "WORKFLOW_04_EIGHT_OBJECTS",
  "WORKFLOW_06_MULTI_TURN",
  "LIFECYCLE_07_CREATE_REVERSE_REMOVE",
  "EDGE_07_AMBIGUITY",
  "TEXT_01",
];
export function modelQualification(report: {
  providerMode: string;
  model?: string;
  results: {
    evalId: string;
    status: string;
    expectedOutcome?: string;
    stages?: Record<string, string>;
  }[];
}) {
  const failures: string[] = [];
  if (report.providerMode !== "live") failures.push("LIVE_PROVIDER_REQUIRED");
  if (!report.model) failures.push("EXPLICIT_MODEL_REQUIRED");
  for (const id of qualificationCases) {
    const row = report.results.find((r) => r.evalId === id);
    if (!row) {
      failures.push(id + ": MISSING");
      continue;
    }
    if (row.status !== "PASSED") failures.push(id + ": FAILED");
    if (row.expectedOutcome !== "REJECT") {
      if (row.stages?.semantic === "FAILED")
        failures.push(id + ": SEMANTICS_FAILED");
      if (row.stages?.compilation !== "PASSED")
        failures.push(id + ": COMPILATION_NOT_CONFIRMED");
      if (
        !["PASSED", "PASSED_NO_STATE_DIFF"].includes(
          row.stages?.execution ?? "",
        )
      )
        failures.push(id + ": EXECUTION_NOT_CONFIRMED");
      if (row.stages?.visual !== "PASSED")
        failures.push(id + ": RENDER_NOT_CONFIRMED");
    }
  }
  return {
    suiteVersion: "model-qualification/1",
    status: failures.length
      ? "NOT_QUALIFIED"
      : "QUALIFIED_FOR_TESTED_WORKFLOWS",
    requiredCases: qualificationCases,
    failures,
    artisticQuality: "NOT_TESTED",
    productionReadiness: "NOT_PROVEN",
  };
}
