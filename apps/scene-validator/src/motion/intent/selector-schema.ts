import { z } from "zod";
import {
  intentRequirementSchema,
  intentPlanSchema,
  intentTechnique,
  type IntentPlan,
} from "./schema.js";
const parameters = intentRequirementSchema.shape.parameters.shape;
/** A smaller wire schema for the SAME planner; normalized into the canonical IntentPlan. */
export const selectorEditSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  requirements: z
    .array(
      z.object({
        requirementId: z.string().min(1).max(100),
        kind: z.enum(["editAnimation", "unsupported"]),
        sourceText: z.string().min(1).max(20000),
        selector: intentRequirementSchema.shape.selector,
        techniques: z.array(intentTechnique).min(1).max(3),
        target: intentRequirementSchema.shape.target.optional(),
        sceneId: z.string().nullable().optional(),
        expressionAction: intentRequirementSchema.shape.expressionAction,
        effectOperation: intentRequirementSchema.shape.effectOperation,
        temporalReference: intentRequirementSchema.shape.timing.shape.reference,
        delayFrames: z.number().int().optional(),
        startFrame: z.number().int().min(0).optional(),
        timingRelation: z
          .enum(["sceneStart", "sceneEnd", "unchanged"])
          .optional(),
        parameters: z.object({
          amplitudeFactor: parameters.amplitudeFactor.optional(),
          relativeIntensity: parameters.relativeIntensity,
          amplitude: parameters.amplitude.optional(),
          frequencyFactor: parameters.frequencyFactor,
          frequency: parameters.frequency.optional(),
          decay: parameters.decay.optional(),
          durationFactor: parameters.durationFactor.optional(),
          durationSeconds: parameters.durationSeconds.optional(),
          property: parameters.property,
          direction: parameters.direction.optional(),
          easing: parameters.easing.optional(),
        }),
        unresolvedReason: z.string().nullable().optional(),
      }),
    )
    .min(1)
    .max(200),
  coverage: intentPlanSchema.shape.coverage,
  assumptions: intentPlanSchema.shape.assumptions,
});
export function normalizeSelectorPlan(
  input: z.infer<typeof selectorEditSchema>,
  fps?: number,
): IntentPlan {
  return intentPlanSchema.parse({
    ...input,
    requirements: input.requirements.map((r) => ({
      ...Object.fromEntries(
        Object.entries(r).filter(
          ([key]) =>
            ![
              "temporalReference",
              "delayFrames",
              "startFrame",
              "timingRelation",
            ].includes(key),
        ),
      ),
      sceneId: r.sceneId ?? null,
      target: r.target ?? {
        sourceNodeId: null,
        logicalObjectId: null,
        name: null,
      },
      parameters: {
        fromSceneId: null,
        toSceneId: null,
        moveToCenter: null,
        x: null,
        y: null,
        scaleFrom: null,
        scaleTo: null,
        durationSeconds: null,
        distance: null,
        direction: null,
        amplitude: null,
        frequency: null,
        decay: null,
        easing: null,
        durationFactor: null,
        amplitudeFactor: null,
        ...r.parameters,
      },
      timing: {
        startSeconds:
          r.startFrame === undefined
            ? null
            : r.startFrame /
              (fps ??
                (() => {
                  throw new Error("PROJECT_FPS_MISSING");
                })()),
        relation: r.timingRelation ?? "unchanged",
        ...(r.temporalReference ? { reference: r.temporalReference } : {}),
        anchorRequirementId: null,
        delaySeconds: 0,
        ...(r.delayFrames !== undefined ? { offsetFrames: r.delayFrames } : {}),
      },
      inheritFromRequirementId: null,
      inheritanceExplanation: null,
      constraints: [],
      unresolvedReason: r.unresolvedReason ?? null,
    })),
  });
}
export const selectorEditInstructions = `Interpret the entire natural-language request as an edit/removal of EXISTING effects. trimPath/Fade/Slide/etc live in animation tracks; inertia/wiggle live in expressions. Use effectOperation={storage:"animation"|"expression",action:"update"|"remove"} according to the supplied lifecycle catalog. Track edits preserve animationId, timing, easing and geometry. Direction reverse is spatial, hidden-to-visible progress stays 0 to 1. Resolve meaning, pronouns, typo-tolerant references and qualitative modifiers; never compute existing parameter values or invent IDs. Return the compact contract, verbatim sourceText and complete coverage. Explicit object names/IDs take precedence. byExistingEffect is EXPLICIT all matching project expressions; never use it for an unqualified follow-up. recentSuccessfulTargets is the recent committed effect group; currentSelection is explicit selected objects; byScene uses an explicitly requested canonical scene. filteredSet intersects effect/property/scene with base=recentSuccessfulTargets or currentSelection; project is the default only for explicit project filters. Current state is queried deterministically after interpretation. Failed proposals are not committed actions. Do not broaden scope on ambiguity; retain an unsupported requirement. expressionAction=remove removes existing expressions; update preserves IDs and all unspecified values. relativeIntensity selects slightlyWeaker/weaker/muchWeaker/slightlyStronger/stronger/muchStronger, or amplitudeFactor for an explicit numeric ratio. Timing edits use effectOperation={storage:"animation",action:"updateTiming"}; use temporalReference for a READ-ONLY existing anchor, endpoint start/end, with signed delayFrames. No fake edit for the anchor. Empty techniques only for a timing edit where one actual track can be determined. startFrame is an explicit absolute project frame. Do not compute end frames, deterministic resolver queries authoritative state. No new effects/geometry/full project regeneration. Unrelated edits and natural-language Undo are unsupported by this compact contract.`;
