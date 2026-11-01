/** Agent execution policy only. Canonical schemas/math/storage validation never depend on this mode. */
export type AgentValidationMode = 'minimal' | 'strict';
export function agentValidationMode(): AgentValidationMode {
    const mode = process.env.AGENT_VALIDATION_MODE ?? 'minimal';
    if (mode !== 'minimal' && mode !== 'strict') throw Error('INVALID_AGENT_VALIDATION_MODE');
    return mode;
}
export const agentPolicy = (mode: AgentValidationMode) => ({
    mode, mandatoryResultChecks: mode === 'strict', mandatoryQA: mode === 'strict',
    declaredScopeIsBoundary: mode === 'strict',
});
