import {programSchema} from '../motion-library/expressions/program.js';
import {globalFrameSchema, intervalDurationSchema} from "./time.js";
import { TimelineConstraintError } from "./constraints.js";
import { intervalConflict } from "./intervals.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { LoadedProject } from "../types.js";
import { animationSchema,keyframeAnimationSchema,keyframeSchema, objectTransitionSchema, type MotionState, type Plan } from "./schema.js";
import { easingSchema } from "../motion-library/easings/registry.js";
import { expressionSchema, expressionLifecycles } from "../motion-library/expressions/registry.js";
import { channels, applyOperations } from "./operations.js";
import { resolveObjectReference } from "./object-resolution.js";
import { buildRegistry } from "./registry.js";
import { freezeObjectOperations } from "./static-object.js";

const id = z.string().min(1).max(180);
const timingPatch = { startFrame: globalFrameSchema.optional(), durationFrames: intervalDurationSchema.optional() };
const parameters = z.record(z.string(), z.union([z.number().finite(), z.string(), z.boolean(), z.null()]));
/** Tool constructor derives redundant keyframe duration; canonical stored schema remains strict. */
export const keyframeToolAnimationSchema=keyframeAnimationSchema.extend({durationFrames:keyframeAnimationSchema.shape.durationFrames.optional()});
export const toolAnimationSchema=z.union([animationSchema,keyframeToolAnimationSchema]);
export const motionToolSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("freezeObject"), logicalObjectId: id }).strict(),
  z.object({ tool: z.literal("releaseStaticObject"), logicalObjectId: id }).strict(),
  z.object({ tool: z.literal("createAnimation"), animation: toolAnimationSchema }).strict(),
  z.object({ tool: z.literal("updateAnimation"), animationId: id, patch: z.object({ ...timingPatch, easing: easingSchema.optional(), enabled: z.boolean().optional(), parameters: parameters.optional(),keyframes:z.array(keyframeSchema).min(2).max(500).optional() }).strict() }).strict(),
  z.object({ tool: z.literal("addEffect"), expression: expressionSchema }).strict(),
  z.object({ tool: z.literal("updateEffect"), expressionId: id, patch: z.object({ ...timingPatch, enabled: z.boolean().optional(), ownership: expressionSchema.options[0].shape.ownership, transitionId: id.optional(), parameters: parameters.optional(),program:programSchema.optional() }).strict() }).strict(),
  z.object({ tool: z.literal("removeAnimation"), animationId: id, dependentPolicy: z.enum(["reject", "removeDependents"]).default("reject") }).strict(),
  z.object({ tool: z.literal("removeEffect"), expressionId: id }).strict(),
  z.object({ tool: z.literal("createStateTransition"), transition: objectTransitionSchema }).strict(),
  z.object({ tool: z.literal("adjustTimeline"), policy: z.enum(["extendProject", "rejectOverflow"]), durationFrames: z.number().int().positive(), preserveBlocks: z.boolean().optional() }).strict(),
]);
export type MotionTool = z.infer<typeof motionToolSchema>;
export type ToolIssue = { code: string; message: string; details: Record<string, unknown>; allowedActions: string[] };
export class MotionToolError extends Error {
  constructor(readonly issue: ToolIssue) { super(issue.code + ": " + issue.message); this.name = "MotionToolError"; }
}
const fail = (code: string, message: string, details: Record<string, unknown>, allowedActions: string[] = []): never => { throw new MotionToolError({ code, message, details, allowedActions }); };
export const motionStateDigest = (state: MotionState) => createHash("sha256").update(JSON.stringify(state)).digest("hex");

/** One inspection contract over the existing canonical stores; this is not another persisted state. */
export function inspectAnimations(project: LoadedProject, state: MotionState, target?: { sceneId?: string; targetId?: string; logicalObjectId?: string }) {
  const registry = buildRegistry(project.inspection.document, project.inspection.fingerprint);
  const identity = (e: { sceneId: string; targetId: string }) => registry.objects.find(o => o.sourceInstances.some(i => i.sceneId === e.sceneId && i.sourceNodeId === e.targetId))?.logicalObjectId;
  const matches = (e: { sceneId: string; targetId: string }) => (!target?.logicalObjectId || identity(e) === target.logicalObjectId) && (!target?.sceneId || e.sceneId === target.sceneId) && (!target?.targetId || e.targetId === target.targetId);
  return structuredClone([
    ...state.animations.filter(matches).map(a => ({ id: a.animationId, storage: "animation" as const, identity: { sceneId: a.sceneId, sourceNodeId: a.targetId, logicalObjectId: identity(a) }, properties: channels(a), parameters: a.parameters, timing: { startFrame: a.startFrame, durationFrames: a.durationFrames }, easing: a.easing, lifecycle: "finite" as const, composition: "replace" as const, data: a })),
    ...(state.expressions ?? []).filter(matches).map(e => ({ id: e.expressionId, storage: "expression" as const, identity: { sceneId: e.sceneId, sourceNodeId: e.targetId, logicalObjectId: identity(e), transitionId: e.transitionId, ownership: e.ownership ?? { scope: e.transitionId ? "transition" : "sceneInstance" } }, parameters: e.parameters, properties: [e.property], timing: { startFrame: e.startFrame, durationFrames: e.durationFrames }, easing: null, lifecycle: expressionLifecycles[e.type] === "settling" ? "finite" as const : "continuous" as const, requiresSettledEndpoint: expressionLifecycles[e.type] === "settling", composition: "add" as const, data: e })),
    ...(state.objectTransitions ?? []).filter(t => (!target?.logicalObjectId || t.logicalObjectId === target.logicalObjectId) && (!target?.sceneId || [t.fromSceneId, t.toSceneId].includes(target.sceneId)) && (!target?.targetId || registry.objects.some(o => o.logicalObjectId === t.logicalObjectId && o.sourceInstances.some(i => i.sourceNodeId === target.targetId)))).map(t => ({ id: t.transitionId, storage: "transition" as const, identity: { logicalObjectId: t.logicalObjectId, fromSceneId: t.fromSceneId, toSceneId: t.toSceneId }, properties: ["transform", "opacity"], parameters: t.proceduralEffects, timing: { startFrame: t.startFrame, durationFrames: t.durationFrames }, easing: t.easing, lifecycle: "transition" as const, composition: "state" as const, data: t })),
  ]);
}
export type CanonicalMotionEntry = ReturnType<typeof inspectAnimations>[number];
export const findObject = resolveObjectReference;

/** Payload/identity resolution only; the shared operation validator admits the candidate once. */
export function lowerMotionTool(project: LoadedProject, state: MotionState, input: MotionTool): Plan["operations"] {
  const command = motionToolSchema.parse(input);
  // Tools accept a known logical ID as a reference, but persist actual source IDs.
  const sourceTarget=(sceneId:string,targetId:string)=>{const registry=buildRegistry(project.inspection.document,project.inspection.fingerprint);if(registry.objects.some(o=>o.sourceInstances.some(i=>i.sceneId===sceneId&&i.sourceNodeId===targetId)))return targetId;const object=registry.objects.find(o=>o.logicalObjectId===targetId);const refs=object?.sourceInstances.filter(i=>i.sceneId===sceneId)??[];if(refs.length!==1)return fail(refs.length?'AMBIGUOUS_TARGET':'TARGET_NOT_FOUND','Resolve a single current source instance for this scene',{sceneId,targetId},['findObject','inspectObject']);return refs[0].sourceNodeId;};
  if(command.tool==='createAnimation')command.animation.targetId=sourceTarget(command.animation.sceneId,command.animation.targetId);
  if(command.tool==='addEffect')command.expression.targetId=sourceTarget(command.expression.sceneId,command.expression.targetId);
  switch (command.tool) {
    case "freezeObject": return freezeObjectOperations(project, state, command.logicalObjectId);
    case "releaseStaticObject": return [{ type: "removeStaticObject", logicalObjectId: command.logicalObjectId }];
    case "createAnimation":
      if (state.animations.some(a => a.animationId === command.animation.animationId)) return fail("ID_ALREADY_EXISTS", "Use updateAnimation for an existing track", { animationId: command.animation.animationId }, ["updateAnimation"]);
      return [{ type: "addAnimation", animation: animationSchema.parse({...command.animation,durationFrames:command.animation.effect==='keyframes'?(command.animation.durationFrames??command.animation.parameters.points.at(-1)?.frame):command.animation.durationFrames}) }];
    case "updateAnimation": {
      const a = state.animations.find(a => a.animationId === command.animationId);
      const t = state.objectTransitions?.find(t => t.transitionId === command.animationId);
      if (a) {
        if(command.patch.keyframes&&a.effect!=="keyframes")return fail("KEYFRAME_PATCH_REQUIRES_KEYFRAME_TRACK","This patch cannot convert or recreate an existing effect",{animationId:a.animationId});
        const parameters = a.effect === "keyframes" && command.patch.keyframes ? {...a.parameters,...command.patch.parameters,points:command.patch.keyframes} : a.effect === "keyframes" && command.patch.durationFrames && !command.patch.parameters
          ? { ...a.parameters, points: a.parameters.points.map(p => ({ ...p, frame: Math.round(p.frame * command.patch.durationFrames! / a.durationFrames) })) }
          : { ...a.parameters, ...command.patch.parameters };
        const {keyframes,...patch}=command.patch;
        const animation = animationSchema.parse({ ...a, ...patch,...(keyframes&&!patch.durationFrames?{durationFrames:keyframes.at(-1)!.frame}:{}), parameters });
        const conflict = intervalConflict(animation, state.settings.durationFrames, "finite");
        if (conflict) return fail(conflict.code, "Animation exceeds project duration", conflict, ["adjustTimeline", "updateAnimation"]);
        return [{ type: "updateAnimation", animationId: a.animationId, animation }];
      }
      if (t) {
        if (command.patch.parameters || command.patch.keyframes || command.patch.enabled !== undefined) return fail("UNSUPPORTED_TRANSITION_PATCH", "Transition patches support timing and easing only", { transitionId: t.transitionId });
        const next = { ...t, ...command.patch };
        const conflict = intervalConflict(next, state.settings.durationFrames, "transition");
        if (conflict) return fail(conflict.code, "Transition endpoint needs a visible project frame", conflict, ["adjustTimeline", "updateAnimation"]);
        return [{ type: "animateObjectStateTransition", ...next }];
      }
      return fail("ANIMATION_NOT_FOUND", "No current animation with this ID", { animationId: command.animationId }, ["inspectAnimations"]);
    }
    case "addEffect": {
      const e = command.expression;
      const collision=state.expressions?.find(old=>old.expressionId===e.expressionId);
      if(collision&&JSON.stringify(collision)!==JSON.stringify(e))return fail("ID_ALREADY_EXISTS","Use updateEffect to change an existing expression",{expressionId:e.expressionId},["updateEffect"]);
      return [{ type: "setExpression", expression: e }];
    }
    case "updateEffect": {
      const e = state.expressions?.find(e => e.expressionId === command.expressionId);
      if (!e) return fail("EFFECT_NOT_FOUND", "No current expression with this ID", { expressionId: command.expressionId }, ["inspectAnimations"]);
      if(command.patch.program&&e.type!=="procedural")return fail("PROGRAM_PATCH_REQUIRES_PROCEDURAL_EFFECT","Preserve this effect and use its supported parameters",{expressionId:e.expressionId});
      return [{ type: "setExpression", expression: expressionSchema.parse({ ...e, ...Object.fromEntries(Object.entries(command.patch).filter(([, value]) => value !== undefined)), parameters: { ...e.parameters, ...command.patch.parameters } }) }];
    }
    case "removeAnimation": {
      const a = state.animations.find(a => a.animationId === command.animationId);
      const t = state.objectTransitions?.find(t => t.transitionId === command.animationId);
      if (!a && !t) return fail("ANIMATION_NOT_FOUND", "Animation identity no longer exists", { animationId: command.animationId });
      const dependent = (state.expressions ?? []).filter(e => e.textBinding?.animationId===command.animationId||e.transitionId === command.animationId || "sourceAnimationId" in e && e.sourceAnimationId === command.animationId || e.type==="procedural"&&e.program.instructions.some(i=>i.op==="sample"&&i.animationId===command.animationId));
      if (dependent.length && command.dependentPolicy !== "removeDependents") return fail("DEPENDENT_EFFECTS_REQUIRE_POLICY", "Choose explicit dependent deletion or preserve the base", { expressionIds: dependent.map(e => e.expressionId) }, ["removeAnimation:removeDependents", "inspectDependencies"]);
      return [
        ...dependent.map(e => ({ type: "removeExpression" as const, expressionId: e.expressionId })),
        ...(state.timingDependencies ?? []).filter(d => d.animationId === command.animationId || d.anchorAnimationId === command.animationId).map(d => ({ type: "removeTimingDependency" as const, dependencyId: d.dependencyId })),
        t ? { type: "removeObjectStateTransition" as const, transitionId: t.transitionId } : { type: "removeAnimation" as const, animationId: a!.animationId },
      ];
    }
    case "removeEffect":
      if (!state.expressions?.some(e => e.expressionId === command.expressionId)) return fail("EFFECT_NOT_FOUND", "No current expression with this ID", { expressionId: command.expressionId });
      return [{ type: "removeExpression", expressionId: command.expressionId }];
    case "createStateTransition": {
      const t = command.transition;
      if (state.objectTransitions?.some(old => old.transitionId === t.transitionId)) return fail("ID_ALREADY_EXISTS", "Use updateAnimation to edit this transition", { transitionId: t.transitionId }, ["updateAnimation"]);
      const conflict = intervalConflict(t, state.settings.durationFrames, "transition");
      if (conflict) return fail(conflict.code, "The endpoint needs a visible project frame", conflict, ["adjustTimeline", "updateAnimation"]);
      return [{ type: "animateObjectStateTransition", ...t }];
    }
    case "adjustTimeline": {
      if (command.policy === "rejectOverflow" && command.durationFrames !== state.settings.durationFrames) return fail("TIMELINE_POLICY_REJECTED", "Timeline changes were not authorized", { requested: command.durationFrames }, ["adjustTimeline:extendProject"]);
      if (command.durationFrames < state.settings.durationFrames) return fail("TIMELINE_SHRINK_UNSUPPORTED", "This tool never truncates existing work", { current: state.settings.durationFrames });
      if (command.preserveBlocks) return [{ type: "setProjectSettings", settings: { ...state.settings, durationFrames: command.durationFrames, tailPolicy: "holdLastScene" } }];
      const blocks = structuredClone(state.blocks), last = [...blocks].sort((a, b) => a.startFrame - b.startFrame).at(-1)!;
      last.durationFrames += command.durationFrames - state.settings.durationFrames;
      return [{ type: "setProjectDuration", durationFrames: command.durationFrames }, { type: "setBlocks", blocks }];
    }
  }
}
export function prepareMotionTools(project: LoadedProject, state: MotionState, commands: MotionTool[]) {
  try {
    let candidate = state;
    const batches: Plan["operations"][] = [];
    for (const command of commands) {
      const operations = lowerMotionTool(project, candidate, command);
      candidate = applyOperations(candidate, operations, project);
      batches.push(operations);
    }
    return { ok: true as const, candidate, batches, beforeDigest: motionStateDigest(state) };
  } catch (error) {
    return { ok: false as const, issue: error instanceof MotionToolError ? error.issue : error instanceof TimelineConstraintError ? { code: error.code, message: error.message, details: { requiredDurationFrames: error.requiredDurationFrames, requiredAdditionalFrames: error.requiredDurationFrames - error.actualDurationFrames, affectedIds: error.affectedIds }, allowedActions: ["adjustProjectDuration", "retimeAnimation"] } : { code: error instanceof z.ZodError ? "INVALID_TOOL_ARGUMENT" : "TECHNICAL_INVARIANT_FAILED", message: String(error), details: {}, allowedActions: ["inspectAnimations"] } };
  }
}
/** Resolve a logical state pair without encoding a Figma scene as a video interval. */
export function transitionForTarget(project: LoadedProject, state: MotionState, sceneId: string, targetId: string) {
  const object = buildRegistry(project.inspection.document, project.inspection.fingerprint).objects.find(o => o.sourceInstances.some(i => i.sceneId === sceneId && i.sourceNodeId === targetId));
  if (!object) return undefined;
  const matches = state.objectTransitions?.filter(t => t.logicalObjectId === object.logicalObjectId) ?? [];
  if (matches.length > 1) return fail("AMBIGUOUS_TRANSITION", "Choose the exact transition to edit", { transitionIds: matches.map(t => t.transitionId) }, ["inspectAnimations"]);
  return matches[0];
}
export const motionToolCatalog = ["findObject", "inspectObject", "inspectTimeline", "inspectDependencies", "inspectAnimations", "removeAnimation", "retimeAnimation", "adjustProjectDuration", "validateChanges", "createAnimation", "updateAnimation", "addEffect", "updateEffect", "removeEffect", "createStateTransition", "adjustTimeline", "validatePreview", "commitChanges"] as const;

export const inspectObject = findObject;
export const inspectTimeline = (state: MotionState) => structuredClone({ settings: state.settings, blocks: state.blocks });
export function inspectDependencies(state: MotionState, animationId: string) {
  return structuredClone({ expressions: state.expressions?.filter(e => e.textBinding?.animationId===animationId||e.transitionId === animationId || "sourceAnimationId" in e && e.sourceAnimationId === animationId || e.type==="procedural"&&e.program.instructions.some(i=>i.op==="sample"&&i.animationId===animationId)) ?? [], timing: state.timingDependencies?.filter(d => d.animationId === animationId || d.anchorAnimationId === animationId) ?? [] });
}
// Aliases deliberately reuse canonical tools and candidate admission.
export const validateChanges = prepareMotionTools;
export const retimeAnimation = (project: LoadedProject, state: MotionState, animationId: string, timing: {startFrame?: number; durationFrames?: number}) => state.expressions?.some(e => e.expressionId === animationId) ? lowerMotionTool(project, state, { tool: "updateEffect", expressionId: animationId, patch: timing }) : lowerMotionTool(project, state, { tool: "updateAnimation", animationId, patch: timing });
export const adjustProjectDuration = (project: LoadedProject, state: MotionState, durationFrames: number) => lowerMotionTool(project, state, { tool: "adjustTimeline", policy: "extendProject", durationFrames, preserveBlocks: true });
