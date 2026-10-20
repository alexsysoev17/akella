import { textAnimationSchema } from "../schema.js";
import { z } from "zod";
import { easingSchema } from "../../motion-library/easings/registry.js";
export const intentTechnique = z.enum([
  "slideUp",
  "slideDown",
  "slideLeft",
  "slideRight",
  "fadeIn",
  "fadeOut",
  "trimPath",
  "maskReveal",
  "inertialOvershoot",
  "scaleIn",
  "scaleOut",
  "rotation",
  "moveTo",
  "wiggle",
  "spring",
  "customCurve",
  "objectStateTransition",
]);
export const temporalReferenceSchema = z
  .object({
    kind: z.enum([
      "existingAnimation",
      "existingExpression",
      "sceneBoundary",
      "recentCommittedAnimation",
    ]),
    target: z
      .object({
        sourceNodeId: z.string().optional(),
        name: z.string().optional(),
        sceneId: z.string().optional(),
      })
      .strict(),
    effect: z.string().optional(),
    animationId: z.string().optional(),
    endpoint: z.enum(["start", "end"]),
    resolvedAnimationId: z.string().optional(),
    recentActionId: z.string().optional(),
    resolvedFromActionId: z.string().optional(),
    sourceClauseId: z.string().optional(),
  })
  .strict();
export const intentRequirementSchema = z
  .object({
    semanticActionId: z.string().optional(),
    sourceClauseId: z.string().optional(),
    requirementId: z.string().min(1).max(100),
    kind: z.enum([
      "sceneTiming",
      "objectAnimation",
      "editAnimation",
      "unsupported",
    ]),
    sourceText: z.string().min(1).max(20000),
    sceneId: z.string().nullable(),
    target: z
      .object({
        sourceNodeId: z.string().nullable(),
        logicalObjectId: z.string().nullable(),
        name: z.string().nullable(),
      })
      .strict(),
    techniques: z.array(intentTechnique).max(8),
    selector: z
      .object({
        type: z.enum([
          "explicitObject",
          "currentSelection",
          "recentSuccessfulTargets",
          "byExistingEffect",
          "byAnimatedProperty",
          "byScene",
          "filteredSet",
        ]),
        base: z
          .enum(["project", "recentSuccessfulTargets", "currentSelection"])
          .optional(),
        effect: z
          .enum([
            "trimPath",
            "fadeIn",
            "fadeOut",
            "slideUp",
            "slideDown",
            "slideLeft",
            "slideRight",
            "moveTo",
            "scaleIn",
            "scaleOut",
            "rotation",
            "maskReveal",
            "inertialOvershoot",
            "wiggle",
            "dampedOscillation",
            "spring",
            "bounce",
            "loop",
          ])
          .optional(),
        sceneId: z.string().nullable().optional(),
        property: z
          .enum(["x", "y", "scaleX", "scaleY", "opacity", "rotation"])
          .optional(),
        targetIds: z.array(z.string()).max(200).optional(),
      })
      .strict()
      .optional(),
    targetScope: z.enum(["instance", "logicalObject"]).optional(),
    selectionRequirementId: z.string().optional(),
    expressionIds: z.array(z.string()).max(5000).optional(),
    expressionAction: z.enum(["update", "remove", "enable", "disable"]).optional(),
    effectOperation: z
      .discriminatedUnion("storage", [
        z
          .object({
            storage: z.literal("animation"),
            action: z.enum(["update", "remove", "updateTiming", "enable", "disable"]),
          })
          .strict(),
        z
          .object({
            storage: z.literal("expression"),
            action: z.enum(["update", "remove", "enable", "disable"]),
          })
          .strict(),
      ])
      .optional(),
    animationIds: z.array(z.string()).max(5000).optional(),
    parameters: z
      .object({
        entrance: z.enum(["offscreen"]).nullable().optional(),
        text: textAnimationSchema.nullable().optional(),
        property: z
          .enum(["x", "y", "rotation", "scaleX", "scaleY", "opacity"])
          .nullable()
          .optional(),
        lifetime: z.enum(["scene", "project"]).nullable().optional(),
        seed: z.number().int().min(0).max(2147483647).nullable().optional(),
        fromSceneId: z.string().nullable().default(null),
        toSceneId: z.string().nullable().default(null),
        moveToCenter: z.boolean().nullable().default(null),
        x: z.number().finite().min(-10000).max(10000).nullable().default(null),
        y: z.number().finite().min(-10000).max(10000).nullable().default(null),
        scaleFrom: z.number().positive().max(100).nullable().default(null),
        scaleTo: z.number().positive().max(100).nullable().default(null),
        durationSeconds: z.number().positive().max(3600).nullable(),
        distance: z.number().positive().max(10000).nullable(),
        direction: z
          .enum(["forward", "reverse", "leftToRight", "rightToLeft"])
          .nullable(),
        amplitude: z.number().min(0).max(10000).nullable(),
        intensity: z
          .enum(["subtle", "normal", "strong", "veryStrong"])
          .nullable()
          .default(null),
        frequencyFactor: z.number().positive().max(10).nullable().default(null),
        frequency: z.number().min(0.01).max(30).nullable(),
        decay: z.number().min(0).max(30).nullable(),
        easing: easingSchema.nullable(),
        durationFactor: z.number().positive().max(10).nullable(),
        amplitudeFactor: z.number().min(0).max(10).nullable(),
        relativeIntensity: z
          .enum([
            "slightlyWeaker",
            "weaker",
            "muchWeaker",
            "slightlyStronger",
            "stronger",
            "muchStronger",
          ])
          .optional(),
      })
      .strict(),
    timing: z
      .object({
        startSeconds: z.number().min(0).max(3600).nullable(),
        relation: z.enum([
          "sceneStart",
          "sceneEnd",
          "afterRequirement",
          "withRequirement",
          "beforeRequirement",
          "unchanged",
        ]),
        anchorRequirementId: z.string().nullable(),
        reference: temporalReferenceSchema.optional(),
        offsetFrames: z.number().int().optional(),
        delaySeconds: z.number().min(-3600).max(3600),
      })
      .strict(),
    inheritFromRequirementId: z.string().nullable(),
    inheritanceExplanation: z.string().nullable(),
    constraints: z.array(z.string().max(2000)).max(20),
    unresolvedReason: z.string().nullable(),
  })
  .strict();
export const intentPlanSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    sourceClauses: z
      .array(
        z
          .object({
            clauseId: z.string(),
            text: z.string(),
            start: z.number().int(),
            end: z.number().int(),
          })
          .strict(),
      )
      .optional(),
    requirements: z.array(intentRequirementSchema).min(1).max(200),
    coverage: z
      .array(
        z
          .object({
            sourceText: z.string().min(1),
            requirementIds: z.array(z.string()),
            classification: z.enum(["executable", "unsupported", "context"]),
            explanation: z.string(),
          })
          .strict(),
      )
      .min(1)
      .max(300),
    assumptions: z.array(z.string().max(2000)).max(60),
  })
  .strict();
export type IntentPlan = z.infer<typeof intentPlanSchema>;
export type IntentRequirement = z.infer<typeof intentRequirementSchema>;
export type IntentTechnique = z.infer<typeof intentTechnique>;
export interface IntentProvider {
  interpret(
    context: unknown,
    request: string,
    feedback?: unknown,
  ): Promise<IntentPlan>;
  audit(
    context: unknown,
    request: string,
    plan: IntentPlan,
  ): Promise<IntentPlan>;
}
