import {createHash} from 'node:crypto';
import type {LoadedProject} from '../types.js';
import type {Plan} from './schema.js';
import {lowerMotionTool,transitionForTarget} from './tools.js';
import {wiggleIntensityDefaults} from '../motion-library/expressions/registry.js';
import { expressionSchema, effectIntensityDefaults, type Expression } from "../motion-library/expressions/registry.js";
import type { IntentRequirement } from "./intent/schema.js";
import type { MotionState } from "./schema.js";

/** Parameter-only mutation over the actual expression, never a reconstructed model snapshot. */
export function editExpression(existing: Expression, request: Pick<IntentRequirement,'effectOperation'|'expressionAction'>&{parameters:Partial<IntentRequirement['parameters']>}, state: MotionState, editDuration = true): Expression {
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

type WiggleRequest=Pick<IntentRequirement,'sceneId'|'kind'|'targetScope'|'effectOperation'|'expressionAction'>&{target:Pick<IntentRequirement['target'],'sourceNodeId'|'logicalObjectId'>;timing:Pick<IntentRequirement['timing'],'startSeconds'|'reference'|'anchorRequirementId'|'offsetFrames'|'delaySeconds'>;parameters:Partial<IntentRequirement['parameters']>};
const stable=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0,16);
/** Seeded additive X/Y expressions; an explicit property scopes editing to one channel. */
export function compileWiggle(project: LoadedProject, state: MotionState, r: WiggleRequest, start: number, duration: number): Plan["operations"] {
  const block = state.blocks.find(b => b.sceneId === r.sceneId)!;
  const transition = transitionForTarget(project, state, r.sceneId!, r.target.sourceNodeId!);
  if (r.timing.startSeconds === null && !r.timing.reference && !r.timing.anchorRequirementId) {
    if ((r.parameters.lifetime === "transition" || r.targetScope === "transition") && transition) start = transition.startFrame + (r.timing.offsetFrames ?? Math.round(r.timing.delaySeconds * state.settings.fps));
    else if (r.targetScope === "logicalObject" && r.parameters.lifetime !== "scene") start = r.timing.offsetFrames ?? Math.round(r.timing.delaySeconds * state.settings.fps);
  }
  const old = (state.expressions ?? []).filter(e => e.type === "wiggle" && e.sceneId === r.sceneId && e.targetId === r.target.sourceNodeId && (!r.parameters.property || e.property === r.parameters.property));
  if (new Set(old.map(e => e.property)).size !== old.length) throw new Error("AMBIGUOUS_EFFECT_MATCH: multiple Wiggles write the same channel");
  const properties = r.parameters.property ? [r.parameters.property] : old.length ? old.map(e => e.property) : ["x", "y"] as const;
  return properties.flatMap(property => {
    const existing = old.find(e => e.property === property);
    const end = r.parameters.lifetime === "scene" ? block.startFrame + block.durationFrames : (r.parameters.lifetime === "transition" || r.targetScope === "transition") && transition ? transition.startFrame + transition.durationFrames : r.parameters.lifetime === "project" || r.targetScope === "logicalObject" || (transition && r.targetScope !== "instance") ? state.settings.durationFrames : block.startFrame + block.durationFrames;
    const logical = r.targetScope === "logicalObject" || transition && r.targetScope !== "instance" && r.targetScope !== "transition";
    const frames = r.parameters.durationSeconds != null ? duration : (r.parameters.lifetime || logical || r.targetScope === "transition") && end > start ? end - start : duration;
    if (frames < 1) throw new Error("INVALID_LIFECYCLE_INTERVAL: Wiggle has no visible interval");
    if (existing?.type === "wiggle") {
      const upsert = structuredClone(r);
      if (upsert.parameters.intensity != null && upsert.parameters.amplitude == null && upsert.parameters.amplitudeFactor == null)
        upsert.parameters.amplitude = wiggleIntensityDefaults[upsert.parameters.intensity].amplitude;
      const next = editExpression(existing, upsert, state);
      if (next.type === "wiggle" && (r.parameters.lifetime || logical && r.kind === "objectAnimation")) {
        next.startFrame = start; next.durationFrames = frames;
      }
      if (logical && r.kind === "objectAnimation") {
        next.ownership = { scope: "logicalObject", logicalObjectId: r.target.logicalObjectId! };
        if (transition) next.transitionId = transition.transitionId;
      }
      return lowerMotionTool(project, state, { tool: "updateEffect", expressionId: next.expressionId, patch: { startFrame: next.startFrame, durationFrames: next.durationFrames, enabled: next.enabled, ownership: next.ownership, transitionId: next.transitionId, parameters: next.parameters } });
    }
    return lowerMotionTool(project, state, { tool: "addEffect", expression: {
      expressionId: "intent_wiggle_" + stable([r.sceneId, r.target.sourceNodeId, property]),
      ...(transition && r.targetScope !== "instance" ? { transitionId: transition.transitionId } : {}),
      ownership: logical ? { scope: "logicalObject" as const, logicalObjectId: r.target.logicalObjectId! } : transition && r.targetScope === "transition" ? { scope: "transition" as const, logicalObjectId: transition.logicalObjectId } : { scope: "sceneInstance" as const },
      sceneId: r.sceneId!, targetId: r.target.sourceNodeId!, type: "wiggle", property,
      startFrame: start, durationFrames: frames, enabled: true,
      parameters: { temporalMode: "continuous", amplitude: r.parameters.amplitude ?? wiggleIntensityDefaults[r.parameters.intensity ?? "normal"].amplitude,
        frequency: r.parameters.frequency ?? wiggleIntensityDefaults[r.parameters.intensity ?? "normal"].frequency,
        seed: r.parameters.seed ?? parseInt(stable([r.sceneId, r.target.sourceNodeId, property]).slice(0, 7), 16) },
    }});
  });
}
