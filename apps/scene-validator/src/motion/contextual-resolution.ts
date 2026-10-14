import { createHash } from "node:crypto";
import type { MotionDocument } from "./store.js";
import type { MotionState } from "./schema.js";
import type { LoadedProject } from "../types.js";
import type { IntentPlan, IntentRequirement } from "./intent/schema.js";
import { objectsIn } from "./context.js";
import { objectMentionRanges } from "./object-aliases.js";
import { resolveObjectReference } from "./object-resolution.js";
export interface RecentAction {
  actionId: string;
  editIds: string[];
  createdAt: string;
  effect: string;
  expressionIds: string[];
  targets: { sceneId: string; targetId: string }[];
}
const projectFilter =
  /все(?:х|м)?\s+(?:об[ъь]?ект|сло|элемент)|всех\s+с\s+(?:инерц|колеб)|об[ъь]?ект\S*[\s\S]*(?:которых\s+есть|с\s+(?:инерц|колеб|анимац))/iu;
const contextualGroup =
  /эти(?:х|м)?(?:\s|$|[,;:])|предыдущ|тех\s+же|те\s+же|выделенн|selected/iu;
const explicitProjectFilter = (text: string) =>
  projectFilter.test(text) && !contextualGroup.test(text);
/** Derived from the effective committed history; never from model proposals or failed runs. */
export function recentSuccessfulActions(doc: MotionDocument): RecentAction[] {
  const groups = new Map<string, RecentAction>();
  for (const entry of doc.history.slice(0, doc.cursor)) {
    const group =
      entry.request.match(/^\[([a-f0-9-]{36})\//)?.[1] ?? entry.editId;
    for (const op of entry.operations) {
      const ids =
        op.type === "setExpression"
          ? [op.expression.expressionId]
          : op.type === "scaleExpressionParameter"
            ? [op.expressionId]
            : [];
      for (const id of ids) {
        const e = entry.after.expressions?.find((e) => e.expressionId === id);
        if (!e) continue;
        const key = group + "/" + e.type,
          action = groups.get(key) ?? {
            actionId: group,
            editIds: [],
            createdAt: entry.createdAt,
            effect: e.type,
            expressionIds: [],
            targets: [],
          };
        if (!action.editIds.includes(entry.editId))
          action.editIds.push(entry.editId);
        if (!action.expressionIds.includes(id)) {
          action.expressionIds.push(id);
          action.targets.push({ sceneId: e.sceneId, targetId: e.targetId });
        }
        action.createdAt = entry.createdAt;
        groups.delete(key);
        groups.set(key, action);
      }
    }
  }
  return [...groups.values()].slice(-20).reverse();
}
export interface ReferenceContext {
  recentActions?: RecentAction[];
  projectRevision?: string;
  selectedObjectId?: string;
  selectedObjectIds?: string[];
  activeSceneId?: string;
}
/** Compatibility for old provider outputs only; new outputs use explicit structured selectors. */
function legacySelector(r: IntentRequirement): IntentRequirement["selector"] {
  if (
    r.target.sourceNodeId ||
    r.target.logicalObjectId ||
    (r.target.name &&
      !/^(их|эти|они|её|его|те же|предыдущие)$/iu.test(r.target.name.trim()))
  )
    return undefined;
  if (
    !r.techniques.includes("inertialOvershoot") ||
    (r.parameters.amplitudeFactor == null &&
      r.parameters.amplitude == null &&
      r.parameters.intensity == null)
  )
    return undefined;
  const text = r.sourceText;
  if (/выделенн/iu.test(text))
    return {
      type: "currentSelection" as const,
      effect: "inertialOvershoot" as const,
    };
  if (explicitProjectFilter(text))
    return {
      type: "byExistingEffect" as const,
      effect: "inertialOvershoot" as const,
      sceneId: /сцен|scene|фрейм|frame|здесь|тут/iu.test(text)
        ? r.sceneId
        : null,
    };
  if (r.sceneId && /сцен|scene|фрейм|frame|здесь|тут/iu.test(text))
    return {
      type: "byScene" as const,
      effect: "inertialOvershoot" as const,
      sceneId: r.sceneId,
    };
  return {
    type: "recentSuccessfulTargets" as const,
    effect: "inertialOvershoot" as const,
  };
}
export function resolveIntentSelectors(
  project: LoadedProject,
  state: MotionState,
  plan: IntentPlan,
  context: ReferenceContext,
  onResolution?: (v: unknown) => void,
) {
  // Revalidate a resolved plan from scratch; provider-supplied membership is never authority.
  const parents = new Map<string, IntentRequirement>();
  const aliases = new Map<string, string>();
  plan.requirements = plan.requirements.filter((r) => {
    if (!r.selectionRequirementId) return true;
    const parent = r.selectionRequirementId;
    aliases.set(r.requirementId, parent);
    if (parents.has(parent)) return false;
    parents.set(parent, r);
    r.requirementId = parent;
    r.selectionRequirementId = undefined;
    r.expressionIds = undefined;
    r.target = { sourceNodeId: null, logicalObjectId: null, name: null };
    return true;
  });
  for (const row of plan.coverage)
    row.requirementIds = [
      ...new Set(row.requirementIds.map((id) => aliases.get(id) ?? id)),
    ];
  const expanded: IntentRequirement[] = [],
    objects = project.inspection.document.scenes.flatMap(objectsIn);
  const replacements = new Map<string, string[]>();
  for (const r of plan.requirements) {
    if (
      r.kind === "unsupported" &&
      r.unresolvedReason &&
      /unsupported (?:technique|operation|capability)|неподдерживаем|geometry|геометр|easing|keyframe|scope.*forbid/i.test(
        r.unresolvedReason,
      )
    ) {
      expanded.push(r);
      continue;
    }
    let selector = r.selector ?? legacySelector(r);
    if (selector && !selector.property && r.parameters.property)
      selector = { ...selector, property: r.parameters.property };
    const requestedSelector = r.selector;
    if (
      selector &&
      explicitProjectFilter(r.sourceText) &&
      (selector.type === "recentSuccessfulTargets" ||
        selector.type === "currentSelection" ||
        selector.base === "recentSuccessfulTargets" ||
        selector.base === "currentSelection")
    ) {
      selector = {
        ...selector,
        type: "byExistingEffect",
        base: "project",
        effect:
          selector.effect ??
          (r.techniques.includes("inertialOvershoot")
            ? "inertialOvershoot"
            : r.techniques.includes("wiggle")
              ? "wiggle"
              : undefined),
      };
    }
    if (
      selector?.type === "recentSuccessfulTargets" &&
      r.target.name &&
      objects.some(
        (o) => o.parentId && objectMentionRanges(o.name, r.sourceText).length,
      )
    ) {
      const named = resolveObjectReference(project, state, {
        referenceText: r.sourceText,
        name: r.target.name,
        sceneId: r.sceneId,
        sourceNodeId: r.target.sourceNodeId,
        activeSceneId: context.activeSceneId,
        selectedObjectId: context.selectedObjectId,
        techniques: r.techniques,
        preferExisting: true,
      });
      if (named.target)
        selector = {
          type: "explicitObject",
          effect: selector.effect,
          sceneId: named.target.sceneId,
          targetIds: [named.target.sourceNodeId],
        };
      else {
        r.kind = "unsupported";
        r.unresolvedReason =
          named.status === "AMBIGUOUS_TARGET"
            ? "AMBIGUOUS_CONTEXTUAL_REFERENCE"
            : "TARGET_NOT_FOUND";
        r.selector = selector;
        expanded.push(r);
        onResolution?.({
          event: "CONTEXTUAL_TARGET_RESOLUTION",
          requirementId: r.requirementId,
          status: r.unresolvedReason,
          source: "explicit-reference",
          candidates: named.candidates,
        });
        continue;
      }
    }
    if (
      !r.selector &&
      selector?.type === "recentSuccessfulTargets" &&
      objects.some(
        (o) => o.parentId && objectMentionRanges(o.name, r.sourceText).length,
      )
    ) {
      expanded.push(r);
      continue;
    }
    if (!selector || r.selectionRequirementId) {
      expanded.push(r);
      continue;
    }
    let matches = (state.expressions ?? []).filter(
      (e) =>
        e.enabled &&
        r.techniques.includes(
          e.type as IntentRequirement["techniques"][number],
        ) &&
        (!selector.effect || e.type === selector.effect) &&
        (!selector.property || e.property === selector.property),
    );
    const scene =
      selector.sceneId ?? (selector.type === "byScene" ? r.sceneId : undefined);
    if (scene) matches = matches.filter((e) => e.sceneId === scene);
    let actionId: string | undefined,
      reason: string | undefined,
      source: string = selector.type;
    if (
      ["byExistingEffect", "byAnimatedProperty", "filteredSet"].includes(
        selector.type,
      ) &&
      !scene &&
      selector.base !== "currentSelection" &&
      selector.base !== "recentSuccessfulTargets" &&
      ((selector.type === "byExistingEffect" && !selector.effect) ||
        !explicitProjectFilter(r.sourceText))
    )
      reason = "SELECTOR_SCOPE_NOT_AUTHORIZED";
    if (
      selector.type === "byScene" &&
      !/сцен|scene|здесь|тут/iu.test(r.sourceText)
    )
      reason = "SELECTOR_SCOPE_NOT_AUTHORIZED";
    if (
      selector.type === "explicitObject" &&
      selector.targetIds?.some(
        (id) =>
          !objects.some(
            (o) =>
              o.targetId === id &&
              (r.sourceText.includes(id) ||
                objectMentionRanges(o.name, r.sourceText).length),
          ),
      )
    )
      reason = "SELECTOR_SCOPE_NOT_AUTHORIZED";
    if (
      selector.type === "currentSelection" ||
      selector.base === "currentSelection"
    ) {
      const selected = new Set(
        context.selectedObjectIds ??
          (context.selectedObjectId ? [context.selectedObjectId] : []),
      );
      const selectionScene = context.selectedObjectIds?.length
        ? undefined
        : context.activeSceneId;
      matches = matches.filter(
        (e) =>
          selected.has(e.targetId) &&
          (!selectionScene || e.sceneId === selectionScene),
      );
    } else if (selector.type === "explicitObject") {
      matches = matches.filter((e) => selector.targetIds?.includes(e.targetId));
    } else if (
      selector.type === "recentSuccessfulTargets" ||
      selector.base === "recentSuccessfulTargets"
    ) {
      const recent = context.recentActions?.find((a) =>
        selector.effect
          ? a.effect === selector.effect
          : r.techniques.includes(
              a.effect as IntentRequirement["techniques"][number],
            ),
      );
      if (recent) {
        actionId = recent.actionId;
        const ids = new Set(recent.expressionIds);
        matches = matches.filter((e) => ids.has(e.expressionId));
      } else if (
        context.selectedObjectIds?.length ||
        context.selectedObjectId
      ) {
        const ids = new Set(
          context.selectedObjectIds ?? [context.selectedObjectId!],
        );
        matches = matches.filter((e) => ids.has(e.targetId));
        source = "currentSelection";
      } else {
        const local = context.activeSceneId
          ? matches.filter((e) => e.sceneId === context.activeSceneId)
          : matches;
        const targets = new Set(local.map((e) => e.sceneId + "/" + e.targetId));
        if (targets.size === 1) {
          matches = local;
          source = context.activeSceneId
            ? "activeSceneUniqueTarget"
            : "uniqueExistingTarget";
        } else {
          reason = targets.size
            ? "AMBIGUOUS_CONTEXTUAL_REFERENCE"
            : "IMPLICIT_REFERENCE_UNRESOLVED";
          matches = [];
        }
      }
    } else if (
      ![
        "byExistingEffect",
        "byAnimatedProperty",
        "byScene",
        "filteredSet",
      ].includes(selector.type)
    )
      reason = "SELECTOR_UNSUPPORTED";
    if (selector.type === "byScene" && !scene) reason = "SELECTOR_UNSUPPORTED";
    if (selector.type === "byAnimatedProperty" && !selector.property)
      reason = "SELECTOR_UNSUPPORTED";
    if (
      selector.type === "filteredSet" &&
      !selector.effect &&
      !selector.property &&
      !scene
    )
      reason = "SELECTOR_UNSUPPORTED";
    if (!matches.length && !reason) reason = "NO_MATCHING_EXISTING_EFFECTS";
    if (
      matches.some(
        (e) =>
          !objects.some(
            (o) => o.sceneId === e.sceneId && o.targetId === e.targetId,
          ),
      )
    )
      reason = "TARGET_NOT_FOUND";
    const sets = new Map<string, typeof matches>();
    for (const e of matches) {
      const key = e.sceneId + "/" + e.targetId;
      sets.set(key, [...(sets.get(key) ?? []), e]);
    }
    if (sets.size > 200) {
      reason = "SELECTOR_UNSUPPORTED_BATCH_LIMIT";
      sets.clear();
    }
    const diagnostic = {
      requirementId: r.requirementId,
      referenceType:
        selector.type === "recentSuccessfulTargets" ||
        selector.base === "recentSuccessfulTargets"
          ? "IMPLICIT"
          : "EXPLICIT_SELECTOR",
      selector,
      requestedSelector,
      source,
      actionId,
      projectRevision: context.projectRevision,
      status: reason ?? "RESOLVED",
      selectedObjectCount: reason ? 0 : sets.size,
      selectedExpressionCount: reason ? 0 : matches.length,
      candidateExpressionCount: matches.length,
      members: matches.map((e) => ({
        sceneId: e.sceneId,
        targetId: e.targetId,
        canonicalName: objects.find(
          (o) => o.sceneId === e.sceneId && o.targetId === e.targetId,
        )?.name,
        expressionId: e.expressionId,
        oldAmplitude: e.parameters.amplitude,
        newAmplitude:
          r.parameters.amplitudeFactor != null
            ? e.parameters.amplitude * r.parameters.amplitudeFactor
            : r.parameters.amplitude,
        property: e.property,
      })),
    };
    onResolution?.({ event: "CONTEXTUAL_TARGET_RESOLUTION", ...diagnostic });
    if (reason) {
      r.kind = "unsupported";
      r.unresolvedReason = reason;
      r.selector = selector;
      expanded.push(r);
      continue;
    }
    const ids: string[] = [];
    for (const [key, expressions] of sets) {
      const e = expressions[0],
        object = objects.find(
          (o) => o.sceneId === e.sceneId && o.targetId === e.targetId,
        );
      if (!object) {
        reason = "TARGET_NOT_FOUND";
        break;
      }
      const id =
        r.requirementId.slice(0, 70) +
        "_" +
        createHash("sha256").update(key).digest("hex").slice(0, 16);
      ids.push(id);
      expanded.push({
        ...structuredClone(r),
        requirementId: id,
        kind: "editAnimation",
        sceneId: e.sceneId,
        target: {
          sourceNodeId: e.targetId,
          logicalObjectId: null,
          name: object.name,
        },
        selector,
        selectionRequirementId: r.requirementId,
        expressionIds: expressions.map((e) => e.expressionId),
        unresolvedReason: null,
        timing: { ...r.timing, relation: "unchanged" },
      });
    }
    replacements.set(r.requirementId, ids);
  }
  plan.requirements = expanded;
  for (const row of plan.coverage) {
    row.requirementIds = row.requirementIds.flatMap(
      (id) => replacements.get(id) ?? [id],
    );
    if (
      row.classification === "unsupported" &&
      row.requirementIds.every(
        (id) =>
          expanded.find((r) => r.requirementId === id)?.kind !== "unsupported",
      )
    )
      row.classification = "executable";
  }
  return plan;
}
