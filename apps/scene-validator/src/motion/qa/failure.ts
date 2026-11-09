export type FailureCategory =
  | "animation-validation"
  | "rendering-infrastructure"
  | "provider-or-budget";
export function failureCategory(error: unknown): FailureCategory {
  const text =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? String(error)
        : JSON.stringify(error);
  if (
    /Aborted\(|SURFACE_ALLOCATION_FAILED|SURFACE_ALLOCATION|out of memory|memory access out of bounds|NATIVE_WORKER|Native worker exited|NATIVE_RENDERER_CLOSED|RENDER_INFRASTRUCTURE_FAILED|TEXT_.*ALLOCATION_FAILED/i.test(
      text,
    )
  )
    return "rendering-infrastructure";
  if (
    /CONTEXT_EXHAUSTED|CONTEXT_BUDGET|REPAIR_CONTEXT_BUDGET|TOKEN_BUDGET|TIME_BUDGET|EXECUTION_TIMEOUT|CANCELLED|AUTH_REQUIRED|RATE_LIMITED|UNAVAILABLE|PROVIDER_/i.test(
      text,
    )
  )
    return "provider-or-budget";
  return "animation-validation";
}
export function infrastructureFailure(report: {
  checks?: { status: string; reason?: string }[];
}) {
  return (report.checks ?? []).some(
    (c) =>
      c.status === "FAILED" &&
      failureCategory(c.reason ?? "") === "rendering-infrastructure",
  );
}
/** One infrastructure retry, never an LLM/semantic retry. Keep the original report if recovery fails. */
export async function verifyWithInfrastructureRecovery<
  T extends { checks?: { status: string; reason?: string }[] },
>(
  verify: () => Promise<T>,
  reset: () => Promise<unknown>,
  notify: () => Promise<unknown>,
) {
  const original = await verify();
  if (!infrastructureFailure(original)) return original;
  try {
    await notify();
    await reset();
    const result = await verify();
    return {
      ...result,
      infrastructureRecovery: { attempts: 1, originalChecks: original.checks },
    };
  } catch (error) {
    return {
      ...original,
      infrastructureRecovery: {
        attempts: 1,
        error: String(error),
        originalChecks: original.checks,
      },
    };
  }
}
