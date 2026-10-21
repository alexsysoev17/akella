import type { HarnessRun } from "../runtime.js";
/** Independent measured recovery budget, within the existing global Harness budget.
 * SDK output caps are checked after the response when the transport cannot enforce them. */
export function recoveryProviderRuntime(run: HarnessRun, firstCall: number, remainingMs?: number) {
    const runtime = run.providerRuntime(), policy = run.config.recovery;
    const check = () => {
        const calls = run.calls.slice(firstCall);
        const measured = calls.reduce((n, c) => n + (c.usage ? c.usage.inputTokens + c.usage.outputTokens : 0), 0);
        const knownCost = calls.reduce((n, c) => n + (c.cost ?? 0), 0);
        if (measured > policy.maxTokens || policy.maxEstimatedCost !== null && knownCost > policy.maxEstimatedCost)
            throw new Error("RECOVERY_PROVIDER_BUDGET");
    };
    return { ...runtime,
        providerTimeoutMs: Math.min(runtime.providerTimeoutMs, remainingMs ?? policy.maxDurationMs),
        maxOutputTokens: policy.maxOutputTokens, reasoningEffort: policy.effort, includeCapabilityGuidance: false,
        invoke: async (...args: Parameters<typeof runtime.invoke>) => { check(); const result = await runtime.invoke(...args); check(); return result; },
    };
}
