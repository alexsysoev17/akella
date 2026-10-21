import { z } from "zod";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { isolateCodeRepair, materializeCodeProposal, testCodeProposal, codeProposalSchema } from "./code-repair.js";
import { CodexProvider } from "../../motion/provider.js";
import type { ProviderSettings } from "../../motion/provider-settings.js";
import type { RecoveryPolicy } from "./config.js";
import type { RecoveryFailure } from "./failure.js";
/** Separate, one-call coding role. No Motion Tools, no shell, no production write grant.
 * No project assets or user prompt are sent; only code + a sanitized technical failure. */
export async function proposeCodeRepair(repository: string, failure: RecoveryFailure, policy: RecoveryPolicy, settings: ProviderSettings, signal?: AbortSignal) {
    if (!policy.codeRepair.enabled)
        return { status: "DISABLED", promotion: "DISABLED" };
    if (!failure.codeRepairEligible)
        return { status: "NOT_ELIGIBLE", reason: "A task failure alone is not evidence of an implementation defect" };
    const workspace = await isolateCodeRepair(repository, failure, [failure.category === "MISSING_CAPABILITY" ? "apps/scene-validator/src/motion/tools.ts" : "apps/scene-validator/src/motion/intent/execution.ts"]);
    const directory = path.join(workspace.root, "coding-provider");
    await mkdir(directory);
    let usage: unknown = null;
    const controller = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(policy.codeRepair.maxDurationMs)]);
    const provider = new CodexProvider({ ...settings, model: policy.codeRepair.model }, directory, {
        signal: controller, providerTimeoutMs: policy.codeRepair.maxDurationMs, maxOutputTokens: policy.codeRepair.maxOutputTokens, privacy: "full", reasoningEffort: policy.codeRepair.effort, includeCapabilityGuidance: false,
        invoke: async (adapter, req) => {
            if (Buffer.byteLength(JSON.stringify(req)) > policy.codeRepair.maxContextBytes)
                throw new Error("CODE_REPAIR_CONTEXT_BUDGET");
            const result = await adapter.generate({ ...req, signal: controller });
            usage = { usage: result.usage, latencyMs: result.latencyMs, estimatedCost: result.estimatedCost, model: req.model };
            if (result.toolCalls.length)
                throw new Error("CODE_REPAIR_FORBIDDEN_TOOL");
            if (result.usage && result.usage.outputTokens > req.maxOutputTokens)
                throw new Error("CODE_REPAIR_OUTPUT_BUDGET");
            if (result.usage && result.usage.inputTokens + result.usage.outputTokens > policy.codeRepair.maxTokens)
                throw new Error("CODE_REPAIR_TOKEN_BUDGET");
            if (policy.codeRepair.maxEstimatedCost !== null && result.estimatedCost !== null && result.estimatedCost > policy.codeRepair.maxEstimatedCost)
                throw new Error("CODE_REPAIR_COST_BUDGET");
            return result;
        },
    });
    const decision = await provider.structured({ failure: { code: failure.code, category: failure.category, stage: failure.stage, evidence: failure.evidence.map(e => ({ source: e.source, detail: failure.code })) }, files: workspace.files, baseCommit: workspace.baseCommit }, "Produce a narrow, reviewable source repair and a NEW synthetic regression test.", "You are the isolated Code Repair role, not the project agent. Read only supplied code. No shell/filesystem/network tools. Return action=propose with proposal only when evidence establishes a source defect; otherwise action=stop, proposal=null and reason. Prefer small exact find/replace edits on existing files with exact beforeHash; full content is required only for NEW regression tests. Each find must occur exactly once; new test beforeHash is SHA256 of empty text. Never change permissions, configuration, source Figma data, unrelated modules, tests already present, QA tolerances or validation to conceal a failure. Explain actual root cause; do not claim tests ran. The backend will sandbox tests. This proposal never activates itself. If the source does not establish a defect, do not invent a repair.", z.object({ action: z.enum(["propose", "stop"]), proposal: codeProposalSchema.nullable(), reason: z.string().max(2000) }).strict(), "code-repair");
    if (decision.action === "stop" || !decision.proposal)
        return { status: "INSUFFICIENT_EVIDENCE", reason: decision.reason, workspace: workspace.root, promotion: "DISABLED", metrics: usage };
    const materialized = await materializeCodeProposal(workspace, decision.proposal), verification = await testCodeProposal(repository, materialized, controller);
    return { ...verification, workspace: workspace.root, patch: path.join(workspace.root, "proposal.patch"), metrics: usage };
}
