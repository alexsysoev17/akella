import { z } from "zod";
import { springParameters, bounceParameters } from "../easings/registry.js";
const finite = (lo: number, hi: number) => z.number().finite().min(lo).max(hi);
const id = z.string().min(1).max(180);
export const propertySchema = z.enum([
  "x",
  "y",
  "scaleX",
  "scaleY",
  "rotation",
  "opacity",
]);
const common = {
  expressionId: id,
  sceneId: id,
  targetId: id,
  property: propertySchema,
  startFrame: z.number().int().min(0).max(108000),
  durationFrames: z.number().int().min(1).max(108000),
  enabled: z.boolean(),
};
const amplitude = finite(0, 10000),
  frequency = finite(0.01, 30),
  decay = finite(0, 30);
export const expressionSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...common,
      type: z.literal("wiggle"),
      parameters: z
        .object({
          amplitude,
          frequency,
          seed: z.number().int().min(0).max(2147483647),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("dampedOscillation"),
      parameters: z.object({ amplitude, frequency, decay }).strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("inertialOvershoot"),
      sourceAnimationId: id,
      parameters: z
        .object({
          amplitude: finite(0, 2),
          frequency,
          decay,
          velocityLookbackFrames: finite(0.01, 30).default(6),
          mode: z.enum(["legacy", "ae"]).optional(),
          incomingImpulse: finite(-100000, 100000).nullable().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("spring"),
      parameters: springParameters.extend({ amplitude }).strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("bounce"),
      parameters: bounceParameters.extend({ amplitude }).strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("loop"),
      sourceAnimationId: id,
      parameters: z
        .object({
          mode: z.enum(["cycle", "pingPong"]),
          amplitude: finite(0, 10),
        })
        .strict(),
    })
    .strict(),
]);
export type Expression = z.infer<typeof expressionSchema>;
export const expressionRegistry = expressionSchema.options.map((option) => ({
  id: option.shape.type.value,
  parameterSchema: z.toJSONSchema(option.shape.parameters),
  description: {
    wiggle: "Seeded smooth value noise; units/sec frequency.",
    dampedOscillation: "Additive sine with exponential decay per second.",
    inertialOvershoot:
      "Base velocity × amplitude × damped sine. New inertia defaults to the core instantaneous derivative at incomingKeyTime-frameDuration/10, for any base easing, with exponential damping. mode is an internal algorithm version: ae=current, absent/legacy in stored states=compatibility. Users do not choose AE.",
    spring: "Finite analytic spring offset.",
    bounce: "Finite ballistic offset.",
    loop: "Loop a base track, as an additive difference from its endpoint. Cycle requires equal endpoints; pingPong permits unequal.",
  }[option.shape.type.value],
}));
export const inertiaIntensityDefaults = {
  subtle: { amplitude: 0.1, frequency: 2.5, decay: 3 },
  normal: { amplitude: 0.25, frequency: 2.5, decay: 3 },
  strong: { amplitude: 0.4, frequency: 2.5, decay: 3 },
} as const;
