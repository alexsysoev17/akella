import { expressionSchema, effectIntensityDefaults, type Expression } from "../motion-library/expressions/registry.js";
import type { IntentRequirement } from "./intent/schema.js";
import type { MotionState } from "./schema.js";

/** Parameter-only mutation over the actual expression, never a reconstructed model snapshot. */
export function editExpression(existing: Expression, request: IntentRequirement, state: MotionState, editDuration = true): Expression {
  const next = structuredClone(existing), p = request.parameters;
  const action = request.effectOperation?.action ?? request.expressionAction;
  if (action === "enable" || action === "disable") {
    next.enabled = action === "enable";
    return next;
  }
  if (p.amplitudeFactor != null) next.parameters.amplitude *= p.amplitudeFactor;
  else if ((next.type === "inertialOvershoot" || next.type === "wiggle") && p.intensity != null && p.amplitude == null) {
    const defaults = effectIntensityDefaults[next.type];
    next.parameters.amplitude *= defaults[p.intensity].amplitude / defaults.normal.amplitude;
  }
  if (p.amplitude != null) next.parameters.amplitude = p.amplitude;
  if ("frequency" in next.parameters) {
    if (p.frequencyFactor != null) next.parameters.frequency *= p.frequencyFactor;
    if (p.frequency != null) next.parameters.frequency = p.frequency;
  }
  if ("decay" in next.parameters && p.decay != null) next.parameters.decay = p.decay;
  if ("decay" in next.parameters && p.decay == null && p.decayFactor != null) next.parameters.decay *= p.decayFactor;
  if (!("decay" in next.parameters) && (p.decay != null || p.decayFactor != null)) throw new Error("EFFECT_PARAMETER_UNSUPPORTED: this effect has no decay envelope");
  if (next.type === "wiggle") {
    if (p.seed != null) next.parameters.seed = p.seed;
    if (p.lifetime) {
      const block = state.blocks.find(b => b.sceneId === next.sceneId);
      if (!block && !next.transitionId) throw new Error(`INVALID_LIFECYCLE_INTERVAL: missing scene ${next.sceneId}`);
      next.durationFrames = (p.lifetime === "project" || next.transitionId ? state.settings.durationFrames : block!.startFrame + block!.durationFrames) - next.startFrame;
      next.parameters.temporalMode = "continuous";
    }
  }
  if (editDuration) {
    if (p.durationFactor != null) next.durationFrames = Math.max(1, Math.round(next.durationFrames * p.durationFactor));
    if (p.durationSeconds != null) next.durationFrames = Math.max(1, Math.round(p.durationSeconds * state.settings.fps));
  }
  const parsed = expressionSchema.safeParse(next);
  if (!parsed.success) throw new Error(`INVALID_EFFECT_PARAMETER: ${existing.sceneId}/${existing.targetId} ${existing.type} ${existing.expressionId}: ${parsed.error.issues.map(i => i.path.join(".") + " " + i.message).join("; ")}`);
  return parsed.data;
}
