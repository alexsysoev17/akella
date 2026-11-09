/** Application defaults, never an entitlement claim or an implicit fallback chain. */
export const DEFAULT_MOTION_MODEL = 'gpt-6-astra';
export const DEFAULT_MOTION_REASONING = 'medium' as const;
export function effectiveMotionModel(settings:{provider:string;model:string;reasoningEffort?:'low'|'medium'|'high'}) {
  return {model:settings.model || (/^codex-(?:sdk|cli)$/.test(settings.provider)?DEFAULT_MOTION_MODEL:''),reasoningEffort:settings.reasoningEffort??DEFAULT_MOTION_REASONING};
}
