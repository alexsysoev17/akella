/** Shared admission contract for semantic, legacy and manual application paths. */
export function qaAdmission(value: unknown) {
  const report =
    value && typeof value === "object"
      ? (value as { status?: string; checks?: unknown[] })
      : {};
  const checks = (Array.isArray(report.checks) ? report.checks : []).filter(
    (
      v,
    ): v is {
      name?: string;
      status?: string;
      required?: boolean;
      category?: string;
    } => !!v && typeof v === "object",
  );
  const blockers = checks.filter(
    (c) =>
      c.category !== "artistic" &&
      (c.status === "FAILED" || (c.required === true && c.status !== "PASSED")),
  );
  return {
    accepted:
      ["PASSED", "WARNING"].includes(report.status ?? "") &&
      blockers.length === 0,
    renderValidation:
      blockers.length || report.status === "FAILED"
        ? "FAILED"
        : report.status === "NOT_TESTED" ||
            !report.status ||
            !checks.some(
              (c) => c.category === "render" || c.name === "renderedFrames",
            )
          ? "NOT_TESTED"
          : checks.some(
                (c) => c.category === "render" && c.status === "NOT_TESTED",
              )
            ? "NOT_TESTED"
            : report.status,
    blockers: blockers.map((c) => ({ name: c.name, status: c.status })),
    artisticQuality: "NOT_TESTED" as const,
  };
}
