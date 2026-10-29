import { z } from 'zod';
import { easingSchema } from '../motion-library/easings/registry.js';
const id = z.string().min(1).max(180);
export const ruleScopeSchema = z.object({
    selector: z.enum(["objects", "project"]).default("objects"),
    logicalObjectIds: z.array(id).max(200).default([]),
    sceneId: id.optional(), startSeconds: z.number().finite().optional(), endSeconds: z.number().finite().optional(),
    phase: z.enum(['all', 'entrance']).default('all'),
}).strict().refine(s => s.startSeconds === undefined || s.endSeconds === undefined || s.endSeconds > s.startSeconds, 'Invalid rule interval');
export const ruleParametersSchema = z.object({ amplitude: z.number().min(0).max(100000).optional(), frequency: z.number().min(.001).max(10000).optional(), decay: z.number().min(0).max(10000).optional(), durationSeconds: z.number().min(.05).max(10).optional(), property: z.enum(['x', 'y', 'rotation', 'scaleX', 'scaleY']).optional(), easing: easingSchema.optional() }).strict();
export const motionRuleSchema = z.object({ ruleId: id, effect: z.enum(['inertialOvershoot', 'wiggle', 'fade', 'easing']), scope: ruleScopeSchema, parameters: ruleParametersSchema, enabled: z.boolean(), priority: z.number().int().min(0).max(1000000), sourceText: z.string().min(1).max(20000), exceptions: z.array(id).max(200).default([]) }).strict();
export const semanticEditSchema = z.object({
    operation: z.enum(['ADD_EFFECT', 'MODIFY_EFFECT', 'REMOVE_EFFECT', 'ADD_RULE', 'MODIFY_RULE', 'REMOVE_RULE', 'ADD_EXCEPTION', 'REMOVE_EXCEPTION']),
    effect: motionRuleSchema.shape.effect, ruleId: id.optional(),
    // Names/IDs are interpreted by the existing project registry, never synthesized IDs.
    targets: z.array(z.string().min(1)).max(200).default([]),
    excludedTargets: z.array(z.string().min(1)).max(200).default([]),
    scope: ruleScopeSchema, parameters: ruleParametersSchema,
    amplitudeFactor: z.number().positive().max(10).optional(),
}).strict();
export type MotionRule = z.infer<typeof motionRuleSchema>;
export type SemanticEdit = z.infer<typeof semanticEditSchema>;
export const ruleMaterializationSchema = z.object({ ruleId: id, entity: z.enum(['expression', 'animation', 'transition']), id, before: z.unknown().optional() }).strict();
