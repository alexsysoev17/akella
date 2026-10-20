import { locateSource } from "./provenance.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  intentPlanSchema,
  intentRequirementSchema,
  intentTechnique,
  temporalReferenceSchema,
  type IntentPlan,
} from "./schema.js";
const parameterKeys = Object.keys(
  intentRequirementSchema.shape.parameters.shape,
) as [string, ...string[]];
export const semanticGraphSchema = z
  .object({
    schemaVersion: z.literal("semantic-graph/1.0"),
    clauses: z
      .array(
        z
          .object({
            clauseId: z.string().min(1),
            text: z.string().min(1),
            occurrence: z.number().int().min(0).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    actions: z
      .array(
        z
          .object({
            actionId: z.string().min(1).max(100),
            clauseId: z.string(),
            kind: z.enum([
              "sceneTiming",
              "objectAnimation",
              "editAnimation",
              "unsupported",
            ]),
            scene: z
              .union([z.string(), z.number().int().positive()])
              .nullable(),
            targets: z.array(z.string().min(1)).max(200),
            techniques: z.array(intentTechnique).max(8),
            parameters: z.array(z.union([
              z.object({ key: z.literal("intensity"), value: intentRequirementSchema.shape.parameters.shape.intensity }).strict(),
              z.object({ key: z.literal("lifetime"), value: intentRequirementSchema.shape.parameters.shape.lifetime }).strict(),
              z.object({ key: z.enum(parameterKeys.filter(k => k !== "intensity" && k !== "lifetime") as [string, ...string[]]), value: z.union([
                z.number().finite(), z.string(), z.boolean(),
                intentRequirementSchema.shape.parameters.shape.easing,
                intentRequirementSchema.shape.parameters.shape.text,
              ]) }).strict(),
            ])).max(30),
            start: z
              .object({
                unit: z.enum(["frames", "seconds"]),
                value: z.number().min(0),
              })
              .strict()
              .optional(),
            relation:
              intentRequirementSchema.shape.timing.shape.relation.optional(),
            dependsOn: z.string().optional(),
            temporalReference: temporalReferenceSchema.optional(),
            delayFrames: z.number().int().optional(),
            inheritFrom: z.string().optional(),
            delaySeconds: z.number().optional(),
            selector: intentRequirementSchema.shape.selector,
            targetScope: intentRequirementSchema.shape.targetScope,
            expressionAction: intentRequirementSchema.shape.expressionAction,
            effectOperation: intentRequirementSchema.shape.effectOperation,
            constraints: z.array(z.string()).max(20),
            unresolvedReason: z.string().nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    assumptions: z.array(z.string()).max(60),
  })
  .strict();
export class GraphReferenceError extends Error {
  constructor(
    readonly graph: z.infer<typeof semanticGraphSchema>,
    readonly issue: {
      actionId: string;
      field: "dependsOn" | "inheritFrom";
      reference: string;
    },
  ) {
    super("UNKNOWN_ACTION_DEPENDENCY: " + JSON.stringify(issue));
  }
}
export type SemanticGraph = z.infer<typeof semanticGraphSchema>;
export const semanticResponseSchema = z.union([
  semanticGraphSchema,
  intentPlanSchema,
]);
/** Migration boundary only: existing IntentPlan/compiler/engine remain authoritative. */
export function normalizeSemanticGraph(
  input: unknown,
  context: unknown,
  request: string,
): IntentPlan {
  if ((input as { schemaVersion?: string })?.schemaVersion === "1.0.0")
    return intentPlanSchema.parse(input);
  const graph = semanticGraphSchema.parse(input),
    c = context as {
      sceneIndex?: { sceneId: string; index: number }[];
      motion?: { settings?: { fps: number } };
      project?: { fps?: number };
      objectIndex?: { sourceNodeId: string; name: string; sceneId: string }[];
    };
  const fps = c.motion?.settings?.fps ?? c.project?.fps;
  const readOnly = graph.actions.filter(
    (a) =>
      a.kind === "editAnimation" &&
      !a.effectOperation &&
      !a.expressionAction &&
      !a.parameters.length &&
      !a.start &&
      (!a.relation || a.relation === "unchanged") &&
      !a.dependsOn &&
      !a.inheritFrom &&
      !a.temporalReference &&
      graph.actions.some((b) => b.dependsOn === a.actionId),
  );
  for (const anchor of readOnly) {
    if (anchor.targets.length !== 1 || anchor.techniques.length > 1)
      throw new Error("AMBIGUOUS_TEMPORAL_ANCHOR");
    for (const action of graph.actions.filter(
      (a) => a.dependsOn === anchor.actionId,
    )) {
      const target = anchor.targets[0],
        node = c.objectIndex?.find((o) => o.sourceNodeId === target);
      action.temporalReference = {
        kind: "existingAnimation",
        target: {
          ...(node ? { sourceNodeId: node.sourceNodeId } : { name: target }),
          ...(typeof anchor.scene === "string"
            ? { sceneId: anchor.scene }
            : {}),
        },
        ...(anchor.techniques.length ? { effect: anchor.techniques[0] } : {}),
        endpoint: action.relation === "withRequirement" ? "start" : "end",
        sourceClauseId: anchor.clauseId,
      };
      action.dependsOn = undefined;
    }
  }
  graph.actions = graph.actions.filter((a) => !readOnly.includes(a));

  const actionIds = new Set<string>(),
    clauses = new Map<string, { text: string; start: number; end: number }>();
  for (const clause of graph.clauses) {
    if (clauses.has(clause.clauseId))
      throw new Error("DUPLICATE_SOURCE_CLAUSE");
    const span = locateSource(
      request,
      clause.text,
      (clause as { occurrence?: number }).occurrence,
    );
    clauses.set(clause.clauseId, {
      text: span.text,
      start: span.start,
      end: span.end,
    });
  }
  const memberships = new Map<string, string[]>();
  for (const action of graph.actions) {
    if (actionIds.has(action.actionId))
      throw new Error("DUPLICATE_SEMANTIC_ACTION");
    actionIds.add(action.actionId);
    const targets = action.targets.length ? action.targets : [null];
    if (
      action.kind !== "sceneTiming" &&
      action.kind !== "unsupported" &&
      !action.selector &&
      !action.targets.length
    )
      throw new Error("ACTION_TARGETS_MISSING");
    if (new Set(action.targets).size !== action.targets.length)
      throw new Error("DUPLICATE_ACTION_TARGET");
    memberships.set(
      action.actionId,
      targets.map(
        (target) =>
          "action_" +
          createHash("sha256")
            .update(JSON.stringify([action.actionId, target]))
            .digest("hex")
            .slice(0, 20),
      ),
    );
  }
  const anchor = (id: string | undefined, behavior = false, actionId = "") => {
    if (!id) return null;
    const refs = memberships.get(id);
    if (!refs)
      throw new GraphReferenceError(graph, {
        actionId,
        field: behavior ? "inheritFrom" : "dependsOn",
        reference: id,
      });
    if (refs.length !== 1 && !behavior)
      throw new Error("AMBIGUOUS_GROUP_DEPENDENCY");
    return [...refs].sort()[0];
  };
  const requirements: IntentPlan["requirements"] = [];
  for (const action of graph.actions) {
    const clause = clauses.get(action.clauseId);
    if (!clause) throw new Error("UNKNOWN_SOURCE_CLAUSE");
    const sceneId =
      typeof action.scene === "number"
        ? c.sceneIndex?.find((s) => s.index === Number(action.scene) - 1)
            ?.sceneId
        : action.scene;
    if (action.scene !== null && !sceneId)
      throw new Error("UNKNOWN_SCENE_REFERENCE");
    const parameters: Record<string, unknown> = Object.fromEntries(
      parameterKeys.map((k) => [k, null]),
    );
    delete parameters.relativeIntensity;
    for (const parameter of action.parameters) {
      if (action.parameters.filter((p) => p.key === parameter.key).length !== 1)
        throw new Error("DUPLICATE_ACTION_PARAMETER");
      parameters[parameter.key] = parameter.value;
    }
    let startSeconds: number | null = null;
    if (action.start) {
      if (action.start.unit === "frames" && !fps)
        throw new Error("PROJECT_FPS_MISSING");
      startSeconds =
        action.start.unit === "frames"
          ? action.start.value / fps!
          : action.start.value;
    }
    (action.targets.length ? action.targets : [null]).forEach((target, i) =>
      requirements.push({
        requirementId: memberships.get(action.actionId)![i],
        semanticActionId: action.actionId,
        sourceClauseId: action.clauseId,
        kind: action.kind,
        sourceText: clause.text,
        sceneId: sceneId ?? null,
        target: {
          sourceNodeId:
            c.objectIndex?.find(
              (o) =>
                o.sourceNodeId === target &&
                (!sceneId || o.sceneId === sceneId),
            )?.sourceNodeId ?? null,
          logicalObjectId: null,
          name:
            c.objectIndex?.find(
              (o) =>
                o.sourceNodeId === target &&
                (!sceneId || o.sceneId === sceneId),
            )?.name ?? target,
        },
        targetScope: action.targetScope,
        techniques: action.techniques,
        parameters: intentRequirementSchema.shape.parameters.parse(parameters),
        timing: {
          startSeconds,
          relation:
            action.relation ??
            (action.dependsOn
              ? "afterRequirement"
              : action.kind === "editAnimation"
                ? "unchanged"
                : "sceneStart"),
          anchorRequirementId: anchor(action.dependsOn, false, action.actionId),
          delaySeconds:
            (action.delaySeconds ?? 0) + (action.delayFrames ?? 0) / (fps ?? 1),
          ...(action.temporalReference
            ? { reference: action.temporalReference }
            : {}),
        },
        inheritFromRequirementId: anchor(
          action.inheritFrom,
          true,
          action.actionId,
        ),
        inheritanceExplanation: action.inheritFrom
          ? "Inherited action " + action.inheritFrom
          : null,
        constraints: action.constraints,
        unresolvedReason: action.unresolvedReason,
        ...(action.selector && !action.targets.length
          ? { selector: action.selector }
          : {}),
        ...(action.effectOperation
          ? { effectOperation: action.effectOperation }
          : {}),
        ...(action.expressionAction
          ? { expressionAction: action.expressionAction }
          : {}),
      }),
    );
  }
  return intentPlanSchema.parse({
    schemaVersion: "1.0.0",
    requirements,
    sourceClauses: [...clauses].map(([clauseId, c]) => ({ clauseId, ...c })),
    coverage: graph.clauses.map((clause) => ({
      sourceText: clauses.get(clause.clauseId)!.text,
      requirementIds: graph.actions
        .filter(
          (a) =>
            a.clauseId === clause.clauseId ||
            a.temporalReference?.sourceClauseId === clause.clauseId,
        )
        .flatMap((a) => memberships.get(a.actionId)!),
      classification: graph.actions.some(
        (a) =>
          a.clauseId === clause.clauseId ||
          a.temporalReference?.sourceClauseId === clause.clauseId,
      )
        ? "executable"
        : "context",
      explanation: "Source clause " + clause.clauseId,
    })),
    assumptions: graph.assumptions,
  });
}
export const graphInstructions = `Timing-only edits use effectOperation={storage:"animation",action:"updateTiming"}. Use temporalReference for a READ-ONLY existing anchor (target object/name/scene and optionally exact effect/animationId, endpoint start/end). Never create an edit/no-op action for an existing anchor. dependsOn is only for a real mutation planned in the SAME request. Reference identity/frame arithmetic is resolved deterministically from current state. delayFrames is signed: after end+5, overlap end-10. Existing expression/scene boundary anchor kinds must be diagnosed if scheduler does not support them. Existing effect lifecycle: classify using the supplied capability storage kinds. Existing animation edits/removals use kind=editAnimation and effectOperation={storage:"animation",action:"update"|"remove"}; expressions use storage="expression". Creation remains objectAnimation. Never use expressionAction to remove animation tracks, never mark a supported removal unsupported. trimPath is an animation, not an expression. Reverse path direction updates direction="reverse"; progress stays from=0 to=1. Preserve IDs, geometry, unspecified timing/easing/dependencies. targetScope=instance only for an explicit scene or literal object ID constraint; otherwise logicalObject for existing-motion edits, so the deterministic resolver can find the animated instance. Do not turn active-scene or selected-instance context into an explicit user constraint. intensity accepts subtle/normal/strong/veryStrong. Wiggle always/continuous uses parameters.lifetime=scene (project only when explicitly requested); X/Y are independent additive channels. ENABLE/DISABLE use effectOperation.action=enable/disable. Existing logical-state transition easing/duration edits use effectOperation={storage:"transition",action:"update"}, kind=editAnimation with technique objectStateTransition and the same logical object; never recreate a transition to edit easing. Transition states are Figma references, not fixed video block boundaries. A new one-second transition defaults to the source timeline position; tools enforce global project bounds. Additive Wiggle may bind to the logical state transition; do not create a new base movement for it. Interpret the entire user request semantically. Return the compact semantic graph. Clauses must quote exact contiguous original text and cover every instruction (including scene headers and connecting words); no paraphrases. Harmless whitespace differences are restored to exact original spans. If the same quote appears repeatedly, provide its zero-based occurrence; never guess an ambiguous source span. One action can target multiple named objects with the same behavior. Use object names or canonical source IDs from objectIndex; never invent identifiers. Scene is a canonical sceneId or 1-based scene number. Action IDs are stable references, not array positions. Source clause IDs describe provenance ONLY; dependsOn and inheritFrom are independent action references. For "when it finishes, second ribbon similarly" inheritFrom=first ribbon and dependsOn=first ribbon; text following that clause is a separate action. Temporal anchors must refer to a single-target action. Behavior inheritance may reference a grouped action: only shared techniques/parameters are inherited, never another target's coordinates.
Use current request, not previous conversation, to choose action/technique. Default timing/duration/easing are computed by the compiler: omit unspecified parameters (empty parameters array). Explicit starts keep original units frames/seconds. Parameter values must match supported typed contracts. Unsupported identity is retained with unresolvedReason, never silently broaden targets. A standalone additional fade is objectAnimation/fadeIn preserving base movement. Existing parameter edits are editAnimation. Compound movement/fade/inertia requires all three techniques. Text uses parameters.text={segmentation:block|line|word|character,timing:simultaneous|staggered|sequential,staggerFrames:integer,reverse:boolean,origin:local|outsideViewport|masked}. Staggered requires a positive interval; zero/unspecified is resolved by the library design default. Explicit zero-delay/all-together must use timing=simultaneous. Never claim that staggered/0 is line-by-line timing. One compact instruction expands in renderer; never create an object per letter. For slide+fade use matching text settings on both. Existing text edits preserve tracks; text.segmentation=block removes slicing while preserving block entrance. Below=slideUp, above=slideDown; offscreen entrances use parameter entrance=offscreen. Damped inertia starts after the base endpoint; no fabricated keyframes. True Trim Paths=trimPath, never scale. Explicit easing/scene changes/dependencies must be preserved. AE Easy Ease=aeEasyEase. All technical constraints and engine limits remain enforced by deterministic execution.`;

// Lifecycle interpretation belongs to the same semantic graph and compiler.

// Lifecycle and scope contracts are shared by every provider.
