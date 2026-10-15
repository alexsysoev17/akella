import { presetIdSchema } from "../motion-library/presets/registry.js";
import { z } from "zod";
const id = z.string().min(1).max(180);
const frame = z.number().int().min(0).max(108000);
const duration = z.number().int().min(1).max(108000);
const scalar = z.number().finite().min(-100000).max(100000);
export { easingSchema } from "../motion-library/easings/registry.js";
import { easingSchema } from "../motion-library/easings/registry.js";
import {
  expressionSchema,
  propertySchema,
} from "../motion-library/expressions/registry.js";
export const textAnimationSchema = z
  .object({
    segmentation: z.enum(["block", "line", "word", "character"]),
    timing: z
      .enum(["simultaneous", "staggered", "sequential"])
      .default("staggered"),
    staggerFrames: z.number().int().min(0).max(1000).default(2),
    reverse: z.boolean().default(false),
    origin: z.enum(["local", "outsideViewport", "masked"]).default("local"),
  })
  .strict();
const common = {
  text: textAnimationSchema.optional(),
  animationId: id,
  targetId: id,
  sceneId: id,
  startFrame: frame,
  durationFrames: duration,
  easing: easingSchema,
  enabled: z.boolean(),
};
const numeric = (fallback: number) => scalar.default(fallback);
const fade = z
  .object({ from: z.number().min(0).max(1), to: z.number().min(0).max(1) })
  .strict();
const slide = z
  .object({
    distance: z.number().min(0).max(100000).default(100),
    mode: z.enum(["in", "out"]).default("in"),
  })
  .strict();
const wave = z
  .object({
    property: z.enum(["x", "y", "rotation"]),
    amplitude: numeric(20),
    cycles: z.number().min(0.01).max(100).default(2),
    phase: numeric(0),
    damping: z.number().min(0).max(30).default(4),
  })
  .strict();
export const keyframeSchema = z
  .object({ frame: frame, value: scalar })
  .strict();
export const animationSchema = z.discriminatedUnion("effect", [
  z
    .object({
      ...common,
      effect: z.literal("property"),
      parameters: z
        .object({ property: propertySchema, from: scalar, to: scalar })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      effect: z.literal("fadeIn"),
      parameters: fade.default({ from: 0, to: 1 }),
    })
    .strict(),
  z
    .object({
      ...common,
      effect: z.literal("fadeOut"),
      parameters: fade.default({ from: 1, to: 0 }),
    })
    .strict(),
  ...(["slideUp", "slideDown", "slideLeft", "slideRight"] as const).map(
    (effect) =>
      z
        .object({ ...common, effect: z.literal(effect), parameters: slide })
        .strict(),
  ),
  z
    .object({
      ...common,
      effect: z.literal("scaleIn"),
      parameters: z
        .object({
          from: z.number().min(0.001).max(100).default(0.5),
          to: z.number().min(0.001).max(100).default(1),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      effect: z.literal("scaleOut"),
      parameters: z
        .object({
          from: z.number().min(0.001).max(100).default(1),
          to: z.number().min(0.001).max(100).default(0.001),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      effect: z.literal("rotation"),
      parameters: z.object({ from: numeric(0), to: numeric(90) }).strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      effect: z.literal("moveTo"),
      parameters: z
        .object({ fromX: scalar, fromY: scalar, toX: scalar, toY: scalar })
        .strict(),
    })
    .strict(),
  z
    .object({ ...common, effect: z.literal("oscillation"), parameters: wave })
    .strict(),
  z
    .object({
      ...common,
      effect: z.literal("dampedOscillation"),
      parameters: wave,
    })
    .strict(),
  z
    .object({
      ...common,
      effect: z.literal("maskReveal"),
      parameters: fade.extend({
        direction: z
          .enum(["forward", "reverse", "leftToRight", "rightToLeft"])
          .default("forward"),
      }),
    })
    .strict(),
  z
    .object({
      ...common,
      effect: z.literal("trimPath"),
      parameters: fade.extend({
        direction: z
          .enum(["forward", "reverse", "leftToRight", "rightToLeft"])
          .nullable()
          .optional(),
      }),
    })
    .strict(),
  z
    .object({
      ...common,
      effect: z.literal("keyframes"),
      parameters: z
        .object({
          property: z.enum(["x", "y", "opacity", "scale", "rotation", "trim"]),
          points: z.array(keyframeSchema).min(2).max(500),
        })
        .strict(),
    })
    .strict(),
]);
export const transitionSchema = z
  .object({ type: z.enum(["cut", "crossfade"]), durationFrames: frame })
  .strict();
export const blockSchema = z
  .object({
    blockId: id,
    sceneId: id,
    name: z.string().max(200),
    startFrame: frame,
    durationFrames: duration,
    transition: transitionSchema,
  })
  .strict();
export const settingsSchema = z
  .object({
    fps: z.number().int().min(1).max(60),
    width: z.number().int().min(2).max(4096),
    height: z.number().int().min(2).max(4096),
    durationFrames: duration,
    strictDuration: z.boolean(),
  })
  .strict();
export const objectTransitionSchema = z
  .object({
    transitionId: id,
    logicalObjectId: id,
    fromSceneId: id,
    toSceneId: id,
    startFrame: frame,
    durationFrames: duration,
    easing: easingSchema,
    proceduralEffects: z
      .array(
        z
          .object({
            type: z.literal("dampedOscillation"),
            amplitude: z.number().min(0).max(0.5),
            cycles: z.number().min(0.1).max(10),
            damping: z.number().min(0).max(20),
          })
          .strict(),
      )
      .max(1),
    layerPolicy: z
      .object({
        type: z.literal("switch"),
        switchProgress: z.number().min(0).max(1),
      })
      .strict(),
  })
  .strict();
export type ObjectTransition = z.infer<typeof objectTransitionSchema>;
export const timingDependencySchema = z
  .object({
    dependencyId: id,
    animationId: id,
    anchorAnimationId: id,
    relation: z.enum(["after", "with", "before"]),
    offsetFrames: z.number().int().min(-108000).max(108000),
  })
  .strict();
export const motionSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    settings: settingsSchema,
    blocks: z.array(blockSchema).min(1).max(1000),
    animations: z.array(animationSchema).max(5000),
    timingDependencies: z.array(timingDependencySchema).max(5000).optional(),
    expressions: z.array(expressionSchema).max(5000).optional(),
    objectTransitions: z.array(objectTransitionSchema).max(1000).optional(),
    visibility: z
      .array(
        z.object({ sceneId: id, targetId: id, visible: z.boolean() }).strict(),
      )
      .max(10000),
  })
  .strict();
const animRef = { animationId: id };
export const operationSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("retimeScenes"),
      starts: z
        .array(z.object({ sceneId: id, startFrame: frame }).strict())
        .min(1)
        .max(1000),
    })
    .strict(),
  z
    .object({
      type: z.literal("setTimingDependency"),
      dependency: timingDependencySchema,
    })
    .strict(),
  z
    .object({ type: z.literal("removeTimingDependency"), dependencyId: id })
    .strict(),
  z
    .object({
      type: z.literal("scaleEasingParameter"),
      animationId: id,
      parameter: z.enum([
        "x1",
        "y1",
        "x2",
        "y2",
        "overshoot",
        "amplitude",
        "frequency",
        "decay",
        "stiffness",
        "damping",
        "mass",
        "restitution",
        "bounceCount",
      ]),
      factor: z.number().finite().min(0.01).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("applyMotionPreset"),
      presetId: presetIdSchema,
      instanceId: id,
      sceneId: id,
      targetId: id,
      startFrame: frame,
    })
    .strict(),
  z
    .object({ type: z.literal("setExpression"), expression: expressionSchema })
    .strict(),
  z.object({ type: z.literal("removeExpression"), expressionId: id }).strict(),
  z
    .object({
      type: z.literal("scaleExpressionParameter"),
      expressionId: id,
      parameter: z.enum([
        "amplitude",
        "frequency",
        "decay",
        "stiffness",
        "damping",
        "durationFrames",
      ]),
      factor: z.number().finite().min(0.01).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("animateObjectStateTransition"),
      ...objectTransitionSchema.shape,
    })
    .strict(),
  z
    .object({
      type: z.literal("removeObjectStateTransition"),
      transitionId: id,
    })
    .strict(),
  z
    .object({ type: z.literal("addAnimation"), animation: animationSchema })
    .strict(),
  z.object({ type: z.literal("removeAnimation"), ...animRef }).strict(),
  z
    .object({
      type: z.literal("updateAnimation"),
      ...animRef,
      animation: animationSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("shiftAnimation"),
      ...animRef,
      deltaFrames: z.number().int().min(-108000).max(108000),
    })
    .strict(),
  z
    .object({ type: z.literal("setStartFrame"), ...animRef, startFrame: frame })
    .strict(),
  z
    .object({
      type: z.literal("setDuration"),
      ...animRef,
      durationFrames: duration,
    })
    .strict(),
  z
    .object({ type: z.literal("setEasing"), ...animRef, easing: easingSchema })
    .strict(),
  z
    .object({
      type: z.literal("setEffectParameters"),
      ...animRef,
      parameters: z.union([
        fade,
        slide,
        wave,
        z.object({ from: scalar, to: scalar }).strict(),
        z
          .object({ fromX: scalar, fromY: scalar, toX: scalar, toY: scalar })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      type: z.literal("setKeyframes"),
      ...animRef,
      property: z.enum(["x", "y", "opacity", "scale", "rotation", "trim"]),
      points: z.array(keyframeSchema).min(2).max(500),
    })
    .strict(),
  z
    .object({
      type: z.literal("setBlockDuration"),
      blockId: id,
      durationFrames: duration,
    })
    .strict(),
  z
    .object({
      type: z.literal("setBlockStart"),
      blockId: id,
      startFrame: frame,
    })
    .strict(),
  z
    .object({
      type: z.literal("setSceneTransition"),
      blockId: id,
      transition: transitionSchema,
    })
    .strict(),
  z
    .object({ type: z.literal("setProjectDuration"), durationFrames: duration })
    .strict(),
  z
    .object({ type: z.literal("setProjectSettings"), settings: settingsSchema })
    .strict(),
  z
    .object({
      type: z.literal("setBlocks"),
      blocks: z.array(blockSchema).min(1).max(1000),
    })
    .strict(),
  z
    .object({
      type: z.literal("setVisibility"),
      sceneId: id,
      targetId: id,
      visible: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("stagger"),
      animationIds: z.array(id).min(1).max(500),
      startFrame: frame,
      stepFrames: frame,
    })
    .strict(),
]);
export const operationsSchema = z.array(operationSchema).max(500);
export const planSchema = z
  .object({
    summary: z.string().max(6000),
    status: z.enum(["ready", "unsupported"]),
    assumptions: z.array(z.string().max(2000)).max(30),
    warnings: z.array(z.string().max(2000)).max(50),
    operations: operationsSchema,
  })
  .strict();
export type Animation = z.infer<typeof animationSchema>;
export type MotionState = z.infer<typeof motionSchema>;
export type Operation = z.infer<typeof operationSchema>;
export type Plan = z.infer<typeof planSchema>;

/** Backward compatibility for archived plans/manual JSON; questions can never execute. */
export function parsePlan(value: unknown): Plan {
  if (!value || typeof value !== "object") return planSchema.parse(value);
  const raw = { ...(value as Record<string, unknown>) };
  if ("questions" in raw) {
    if (!Array.isArray(raw.questions) || raw.questions.length)
      throw new Error(
        "Автономная политика: вопросы запрещены. Выберите разумные параметры самостоятельно и верните операции.",
      );
    delete raw.questions;
  }
  return planSchema.parse({ status: "ready", assumptions: [], ...raw });
}
