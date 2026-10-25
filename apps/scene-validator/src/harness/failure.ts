import { redactSecrets } from "./security.js";
import os from "node:os";
export class HarnessStageError extends Error {
  constructor(
    readonly failureStage: string,
    readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "HarnessStageError";
  }
}
export async function duringStage<T>(
  stage: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof HarnessStageError) throw error;
    throw new HarnessStageError(stage, error);
  }
}
export interface FailureDiagnostic {
  originalFailure?:{stage:string;code:string;invariant:string};
  causalChain?:{eventId:string;parentEventId:string|null;rootEventId:string;code:string;stage:string}[];
  failureStage: string;
  errorCode: string;
  errorMessage: string;
  rootCause: string;
  safeStackTrace: string[];
  providerInitializationStatus: string;
}
export function failureDiagnostic(
  error: unknown,
  stage: string,
  providerInitializationStatus: string,
  full: boolean,
): FailureDiagnostic {
  const tagged = error instanceof HarnessStageError ? error : undefined;
  let root = tagged?.cause ?? error;
  const visited = new Set<unknown>();
  while (root instanceof Error && root.cause && !visited.has(root)) {
    visited.add(root);
    root = root.cause;
  }
  const message = error instanceof Error ? error.message : String(error),
    code =
      ((tagged?.cause ?? error) as { code?: unknown })?.code ??
      (root as { code?: unknown })?.code;
  const safe = (v: string) =>
    redactSecrets(v)
      .replaceAll(process.cwd(), "<repository>")
      .replaceAll(os.homedir(), "<home>");
  return {
    failureStage: tagged?.failureStage ?? stage,
    errorCode:
      typeof code === "string"
        ? code
        : (message.match(/^([A-Z][A-Z_0-9]+)(?=:|\b)/)?.[1] ??
          "HARNESS_STARTUP_FAILED"),
    errorMessage: full ? safe(message) : "Details redacted by privacy policy",
    rootCause: full
      ? safe(root instanceof Error ? root.message : String(root))
      : "REDACTED",
    safeStackTrace: full
      ? (root instanceof Error ? (root.stack ?? "") : String(root))
          .split("\n")
          .slice(0, 16)
          .map(safe)
      : [],
    providerInitializationStatus,
  };
}
