import { z } from "zod";
import { objectsIn } from "../../motion/context.js";
import type { LoadedProject } from "../../types.js";
import type { MotionState, Plan } from "../../motion/schema.js";
import type { IntentPlan } from "../../motion/intent/schema.js";
import { compileTasks } from "../../motion/intent/compiler.js";
import { preflightIntentPlan } from "../../motion/intent/execution.js";
import { validateIntentPlan } from "../../motion/intent/planner.js";
import { findObject, inspectAnimations, inspectDependencies, inspectTimeline, lowerMotionTool, motionToolSchema, motionStateDigest } from "../../motion/tools.js";
import { applyOperations } from "../../motion/operations.js";
import { recoveryFailure, type RecoveryFailure } from "./failure.js";
import { recoveryMemory, recoveryRecipes } from "./memory.js";
import type { RecoveryPolicy } from "./config.js";
const inspectionSchema = z.object({ tool: z.enum(["inspectProject", "findObjects", "inspectObject", "inspectAnimations", "inspectAnimation", "resolveObjectReference", "resolveAnimationReference", "inspectTimeline", "inspectDependencies", "validateCandidateState"]), id: z.string().max(180).optional(), name: z.string().max(300).optional() }).strict();
export const recoveryDecisionSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("inspect"), queries: z.array(inspectionSchema).min(1).max(4), reason: z.string().max(1000) }).strict(),
    z.object({ action: z.literal("apply"), commands: z.array(motionToolSchema).min(1).max(12), reason: z.string().max(1000) }).strict(),
    z.object({ action: z.literal("stop"), reason: z.string().max(1000) }).strict(),
    // Kept as an adapter for the existing, tested lifecycle-recovery protocol.
    z.object({ action: z.literal("removeAnimation"), dependentPolicy: z.enum(["reject", "removeDependents"]), reason: z.string().max(1000) }).strict(),
]);
export type RecoveryDecision = z.infer<typeof recoveryDecisionSchema>;
export interface RecoveryReport {
    version: "project-recovery/1";
    status: "Recovering Project" | "Candidate Recovered" | "Project Recovered" | "Failed Safely";
    originalFailure: RecoveryFailure;
    attempts: {
        attempt: number;
        failure: RecoveryFailure;
        action: string;
        tools: unknown[];
        outcome: string;
    }[];
    procedure: string | null;
    codeRepairProposed: boolean;
    metrics?: {
        llmCalls: number;
        inputTokens: number | null;
        outputTokens: number | null;
        estimatedCost: number | null;
    };
    codeRepairEligibility?: string;
    terminalFailure?: RecoveryFailure;
}
export interface RecoveryHooks {
    policy: RecoveryPolicy;
    revision: string;
    request: string;
    checkpoint: () => void;
    decide: (context: unknown, legacy: boolean, remainingMs: number) => Promise<RecoveryDecision>;
    record: (report: RecoveryReport) => Promise<void>;
}
/** No provider/filesystem capability is handed to the model. It chooses JSON commands;
 * lowering/admission/scope/intent checks remain the only authority for candidate writes. */
export async function recoverPreflight(project: LoadedProject, state: MotionState, original: IntentPlan, initialError: unknown, hooks: RecoveryHooks) {
    const plan = structuredClone(original), started = performance.now();
    const overrides = new Map<string, Plan>();
    const initialTask = compileTasks(project, plan).find(t => t.taskId === (initialError as {
        report?: {
            taskId?: string;
        };
    }).report?.taskId);
    const initialReq = plan.requirements.find(r => initialTask?.requirementIds.includes(r.requirementId));
    const report: RecoveryReport = { version: "project-recovery/1", status: "Recovering Project", originalFailure: recoveryFailure(initialError, "preflight", hooks.revision, initialReq), attempts: [], procedure: null, codeRepairProposed: false };
    let error = initialError;
    const seen = new Set<string>();
    const evidence: unknown[] = [];
    const memory = await recoveryMemory(project.root);
    const known = memory.filter(e => e.status === "VERIFIED" && recoveryRecipes.some(r => r.id === e.procedure) && e.signature === report.originalFailure.signature).map(e => e.procedure);
    await hooks.record(report);
    try {
        if (!hooks.policy.enabled || !hooks.policy.maxAttempts)
            throw initialError;
        for (let attempt = 1; attempt <= hooks.policy.maxAttempts; attempt++) {
            hooks.checkpoint();
            if (performance.now() - started > hooks.policy.maxDurationMs)
                throw new Error("RECOVERY_TIME_BUDGET");
            const pre = (error as {
                report?: {
                    taskId?: string;
                    reports?: {
                        operations: Plan["operations"];
                    }[];
                };
            }).report;
            const task = compileTasks(project, plan).find(t => t.taskId === pre?.taskId);
            const req = plan.requirements.find(r => task?.requirementIds.includes(r.requirementId));
            if (!req || !task)
                throw error;
            const failure = recoveryFailure(error, "preflight", hooks.revision, req);
            if (!failure.recoverable)
                throw error;
            const candidate = (pre?.reports ?? []).reduce((s, r) => applyOperations(s, r.operations, project), structuredClone(state));
            const row = { attempt, failure, action: "inspect", tools: [] as unknown[], outcome: "PENDING" };
            report.attempts.push(row);
            // Repair stale bindings only if the old ID is absent and the original name resolves uniquely.
            const resolved = findObject(project, candidate, { name: req.target.name, sceneId: req.sceneId, referenceText: req.sourceText, techniques: req.techniques, preferExisting: true });
            if (resolved.target && req.target.name && (!req.target.sourceNodeId || !project.inspection.document.scenes.flatMap(objectsIn).some(o => o.sceneId === req.sceneId && o.targetId === req.target.sourceNodeId)) && ["STALE_REFERENCE", "AMBIGUITY"].includes(failure.category)) {
                const target = resolved.target;
                if (target.sourceNodeId !== req.target.sourceNodeId || target.sceneId !== req.sceneId) {
                    req.target = { name: target.canonicalName, sourceNodeId: target.sourceNodeId, logicalObjectId: target.logicalObjectId };
                    req.sceneId = target.sceneId;
                    if (req.effectOperation) {
                        req.kind = "editAnimation";
                        req.unresolvedReason = null;
                    }
                    const normalized = validateIntentPlan(project, hooks.request, plan, state.settings.fps, { state: candidate });
                    Object.assign(plan, normalized);
                    row.action = "canonical-reference-rebind/1";
                    row.outcome = "REVALIDATED";
                    report.procedure = row.action;
                    try {
                        const prepared = preflightIntentPlan(project, state, plan, overrides);
                        report.status = "Candidate Recovered";
                        await hooks.record(report);
                        return { plan, prepared, report };
                    }
                    catch (next) {
                        error = next;
                        await hooks.record(report);
                        continue;
                    }
                }
            }
            const bound = req.target.sourceNodeId ? inspectAnimations(project, candidate, { sceneId: req.sceneId ?? undefined, targetId: req.target.sourceNodeId, logicalObjectId: req.target.logicalObjectId ?? undefined }) : resolved.target ? inspectAnimations(project, candidate, { sceneId: resolved.target.sceneId, targetId: resolved.target.sourceNodeId }) : [];
            const legacy = req.techniques.includes("objectStateTransition") && (req.kind === "unsupported" || req.effectOperation?.action === "remove");
            const context = { failure, originalRequirement: req, resolution: resolved, projectRevision: hooks.revision, animations: bound.slice(0, 24), timeline: inspectTimeline(candidate), dependencies: bound.slice(0, 24).map(e => ({ id: e.id, ...inspectDependencies(candidate, e.id) })), previousInspections: evidence, verifiedProcedures: known };
            const bytes = Buffer.byteLength(JSON.stringify(context));
            if (bytes > hooks.policy.maxContextBytes)
                throw new Error("RECOVERY_CONTEXT_BUDGET");
            const decision = recoveryDecisionSchema.parse(await hooks.decide(context, legacy, Math.max(1, hooks.policy.maxDurationMs - (performance.now() - started))));
            const signature = JSON.stringify([motionStateDigest(candidate), decision]);
            if (seen.has(signature))
                throw new Error("RECOVERY_DUPLICATE_ACTION");
            seen.add(signature);
            row.action = decision.action;
            if (decision.action === "stop")
                throw error;
            if (decision.action === "inspect") {
                for (const q of decision.queries) {
                    let result: unknown;
                    if (q.tool === "inspectProject")
                        result = { revision: hooks.revision, fps: candidate.settings.fps, durationFrames: candidate.settings.durationFrames, sceneCount: project.inspection.document.scenes.length };
                    else if (q.tool === "findObjects" || q.tool === "resolveObjectReference")
                        result = resolved;
                    else if (q.tool === "inspectAnimation" || q.tool === "resolveAnimationReference") {
                        if (!bound.some(e => e.id === q.id)) throw new Error("RECOVERY_READ_SCOPE");
                        result = bound.find(e => e.id === q.id);
                    }
                    else if (q.tool === "validateCandidateState") {
                        try { preflightIntentPlan(project, state, plan, overrides); result = { status: "PASSED" }; }
                        catch (e) { result = recoveryFailure(e, "preflight", hooks.revision, req); }
                    }
                    else if (q.tool === "inspectTimeline")
                        result = inspectTimeline(candidate);
                    else if (q.tool === "inspectDependencies") {
                        if (!bound.some(e => e.id === q.id))
                            throw new Error("RECOVERY_READ_SCOPE");
                        result = inspectDependencies(candidate, q.id!);
                    }
                    else if (q.tool === "inspectObject")
                        result = resolved;
                    else
                        result = bound;
                    evidence.push({ query: q, result });
                    row.tools.push(q);
                }
                row.outcome = "INSPECTED";
                await hooks.record(report);
                continue;
            }
            if (decision.action === "removeAnimation") {
                if (!legacy || req.dependentPolicy === "reject" || !resolved.target)
                    throw new Error("RECOVERY_REMOVAL_SCOPE");
                req.kind = "editAnimation";
                req.unresolvedReason = null;
                req.sceneId = resolved.target.sceneId;
                req.target = { name: resolved.target.canonicalName, sourceNodeId: resolved.target.sourceNodeId, logicalObjectId: resolved.target.logicalObjectId };
                req.effectOperation = { storage: "transition", action: "remove" };
                req.dependentPolicy = decision.dependentPolicy;
                row.tools.push({ tool: "removeAnimation", dependentPolicy: decision.dependentPolicy });
            }
            else {
                if (req.kind === "unsupported" || req.unresolvedReason)
                    throw new Error("RECOVERY_UNRESOLVED_INTENT");
                const working = candidate;
                const operations: Plan["operations"] = [];
                for (const command of decision.commands) {
                    if (command.tool === "removeAnimation" && command.dependentPolicy === "removeDependents" && req.dependentPolicy === "reject")
                        throw new Error("RECOVERY_DEPENDENT_DELETE_NOT_AUTHORIZED");
                    if (command.tool === "adjustTimeline" && (plan.timelineExtension === "fixed" || state.settings.timelineExtensionPolicy === "fixed" || command.policy !== "extendProject" || !command.preserveBlocks))
                        throw new Error("RECOVERY_FIXED_TIMELINE");
                    const ops = lowerMotionTool(project, working, command);
                    operations.push(...ops);
                    // Validate the final batch in preflight; invalid intermediate states may be repaired atomically.
                    row.tools.push(command);
                }
                overrides.set(task.taskId, { status: "ready", summary: "Targeted recovery", assumptions: [], warnings: [], operations });
            }
            try {
                const prepared = preflightIntentPlan(project, state, plan, overrides);
                row.outcome = "ADMITTED";
                report.status = "Candidate Recovered";
                report.procedure = "typed-motion-tools/1";
                await hooks.record(report);
                return { plan, prepared, report };
            }
            catch (next) {
                row.outcome = "REJECTED";
                error = next;
                await hooks.record(report);
            }
        }
        throw new Error("RECOVERY_ATTEMPT_LIMIT", { cause: error });
    }
    catch (e) {
        report.status = "Failed Safely";
        report.terminalFailure = recoveryFailure(e, "recovery", hooks.revision);
        const last = report.attempts.at(-1);
        if (last?.outcome === "PENDING") last.outcome = "REJECTED";
        if (report.originalFailure.codeRepairEligible)
            report.codeRepairEligibility = "Evidence requires isolated reproduction; no production code permission";
        await hooks.record(report);
        throw Object.assign(e instanceof Error ? e : new Error(String(e)), { recoveryReport: report });
    }
}
