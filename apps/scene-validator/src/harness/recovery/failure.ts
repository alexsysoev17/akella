import { createHash } from "node:crypto";
import type { IntentRequirement } from "../../motion/intent/schema.js";
import { redactSecrets } from "../security.js";
export type RecoveryCategory = "STALE_REFERENCE" | "AMBIGUITY" | "MISSING_ANIMATION" | "UNSUPPORTED_OPERATION" | "TIMELINE_CONFLICT" | "DEPENDENCY_CONFLICT" | "INVALID_CANDIDATE" | "RENDERER_FAILURE" | "MISSING_CAPABILITY" | "PROBABLE_DEFECT";
export interface RecoveryFailure {
    version: "recovery-failure/1";
    stage: string;
    code: string;
    category: RecoveryCategory;
    signature: string;
    revision: string;
    requirementId?: string;
    target: IntentRequirement["target"] | null;
    invariant: string;
    readSet: string[];
    writeSet: string[];
    remediation: string[];
    recoverable: boolean;
    codeRepairEligible: boolean;
    evidence: {
        source: string;
        detail: string;
    }[];
}
export function recoveryFailure(error: unknown, stage: string, revision: string, requirement?: IntentRequirement): RecoveryFailure {
    const e = error as {
        code?: string;
        report?: {
            code?: string;
            failure?: string;
            availableResolutions?: string[];
            toolIssue?: {
                code?: string;
                allowedActions?: string[];
            };
        };
    };
    const report = e?.report;
    const message = error instanceof Error ? error.message : String(error);
    const rawCode = report?.code ?? report?.toolIssue?.code ?? e?.code ?? message.replace(/^Error: /, "").match(/[A-Z][A-Z_0-9]{3,}/)?.[0] ?? "UNCLASSIFIED_FAILURE";
    const code = /^[A-Z][A-Z_0-9]+$/.test(rawCode) ? rawCode : requirement?.kind === "unsupported" ? "UNSUPPORTED_OPERATION" : "TECHNICAL_VALIDATION_FAILED";
    const category: RecoveryCategory = /STALE|REVISION/.test(code)
        ? "STALE_REFERENCE"
        : /AMBIGUOUS|UNRESOLVED/.test(code)
          ? "AMBIGUITY"
          : /OBJECT_NOT_FOUND|TARGET_NOT_FOUND/.test(code)
            ? "STALE_REFERENCE"
            : /MISSING.*ANIMATION|ANIMATION.*NOT_FOUND|BASE_POSITION|TEMPORAL_ANCHOR|EFFECT_NOT_FOUND/.test(
                  code,
              )
              ? "MISSING_ANIMATION"
              : /TIMELINE|INTERVAL|DURATION|OVERFLOW/.test(code)
                ? "TIMELINE_CONFLICT"
                : /DEPENDENCY|DEPENDENT|REQUIRE_POLICY/.test(code)
                  ? "DEPENDENCY_CONFLICT"
                  : /RENDER|SKIA|WASM|FONT/.test(code)
                    ? "RENDERER_FAILURE"
                    : /MISSING_PATH|CAPABILITY/.test(code)
                      ? "MISSING_CAPABILITY"
                      : /COMPILER_COVERAGE|REQUIREMENT_OPERATIONS_INCOMPLETE|RECOVERY_PROVIDER_BUDGET|RECOVERY_CONTEXT_BUDGET|INVALID_EFFECT_PARAMETER/.test(
                            code,
                        )
                        ? "PROBABLE_DEFECT"
                        : /UNSUPPORTED/.test(code)
                          ? "UNSUPPORTED_OPERATION"
                          : "INVALID_CANDIDATE";
    // A model's assertion is never evidence of a code defect. These signals are produced by admission/rendering.
    const codeRepairEligible =
        category === "PROBABLE_DEFECT" ||
        code === "ENGINE_CAPABILITY_MISSING" ||
        code === "PROVIDER_SCHEMA_INVALID" ||
        /BUDGET|INTERNAL|ASSERTION/.test(code);
    return { version: "recovery-failure/1", stage, code, category,
        signature: createHash("sha256").update(JSON.stringify([stage, code, requirement?.kind, requirement?.techniques])).digest("hex"),
        revision, requirementId: requirement?.requirementId, target: requirement?.target ?? null,
        invariant: redactSecrets(report?.failure ?? message).replace(/\/Users\/[^/\s]+/g, "<home>").slice(0, 2000),
        readSet: requirement?.timing.reference?.resolvedAnimationId ? [requirement.timing.reference.resolvedAnimationId] : [],
        writeSet: [...(requirement?.animationIds ?? []), ...(requirement?.expressionIds ?? [])],
        remediation: report?.availableResolutions ?? report?.toolIssue?.allowedActions ?? ["inspectObject", "inspectAnimations", "inspectDependencies"],
        recoverable: category !== "MISSING_CAPABILITY" && !/CANCEL|BUDGET|TIMEOUT|DEPENDENCY_CYCLE|FIXED|PROVIDER_SCHEMA_INVALID/.test(code),
        codeRepairEligible, evidence: [{ source: stage, detail: code }] };
}
