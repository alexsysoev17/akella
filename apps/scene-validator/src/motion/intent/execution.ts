import {materializeRules,compileSemanticEdit,resolveRuleTargets,ruleObjects} from "../rules.js";
import {refreshTimingOrigins} from "../project-time.js";
import { requiredProjectFrames, TimelineConstraintError } from "../constraints.js";
import { MotionToolError, motionStateDigest } from "../tools.js";
import { failureCategory, infrastructureFailure } from "../qa/failure.js";
import { taskRepairContext } from "./repair-context.js";
import { qaAdmission } from "../qa/policy.js";
import { resolveTextSettings } from "../../motion-library/techniques/text.js";
import { isDeepStrictEqual } from "node:util";
import { freezeObjectOperations } from "../static-object.js";
import { inertiaIntensityDefaults } from "../../motion-library/expressions/registry.js";
import { semanticBindings } from "../../motion-library/techniques/registry.js";
import type { LoadedProject } from "../../types.js";
import type { MotionState, Plan } from "../schema.js";
import type { IntentPlan, IntentRequirement } from "./schema.js";
import {
  requirementAnimations,
  requirementAnchor,
  compileTasks,
  compileRequirement,
  validateRequirement,
  expandInheritance,
  type IntentTask,
} from "./compiler.js";
import { applyOperations, channels, motionDiff } from "../operations.js";
import { resolveTimingDependencies, reanchorExpressions } from "./retime.js";
import { parsePlan } from "../schema.js";
const desiredChannels = (r: IntentRequirement) =>
  new Set(
    r.techniques.flatMap((t) =>
      t.startsWith("slide")
        ? [t === "slideUp" || t === "slideDown" ? "y" : "x"]
        : t.startsWith("fade")
          ? ["opacity"]
          : t === "trimPath"
            ? ["trim"]
            : t.startsWith("scale")
              ? ["scale"]
              : t === "rotation"
                ? ["rotation"]
                : t === "moveTo"
                  ? ["x", "y"]
                  : t === "spring" || t === "customCurve"
                    ? [r.parameters.property ?? "y"]
                    : [],
    ),
  );
export function assertIntentScope(
  project: LoadedProject,
  before: MotionState,
  next: MotionState,
  plan: IntentPlan,
  task: IntentTask,
) {
  if (task.kind === "sceneTiming") {
    const expected = applyOperations(
      before,
      compileRequirement(project, before, plan, task).operations,
      project,
    );
    if (!isDeepStrictEqual(next, expected))
      throw new Error(
        "SCENE_TIMING_SCOPE: repair must execute exact requested starts and deterministic interval retiming",
      );
    return;
  }
  const r = expandInheritance(plan).requirements.find(
    (r) => r.requirementId === task.requirementIds[0],
  )!;
  const own = (a: { sceneId: string; targetId: string }) =>
    a.sceneId === r.sceneId && a.targetId === r.target.sourceNodeId;
  if(r.semanticEdit){const expected=applyOperations(before,compileSemanticEdit(project,before,r.semanticEdit,r.sourceText,r.target.logicalObjectId??undefined),project);if(!isDeepStrictEqual(expected,next))throw Error("RULE_EDIT_SCOPE_VIOLATION");return;}
  if (r.motionAction === "freezeProject") {
    const expected = applyOperations(before, freezeObjectOperations(project, before, r.target.logicalObjectId!), project);
    if (!isDeepStrictEqual(next, expected)) throw new Error("STATIC_OBJECT_SCOPE_VIOLATION");
    return;
  }
  const writes = desiredChannels(r),
    allEdits = r.kind === "editAnimation";
  const permittedIds = new Set(
    [
      ...requirementAnimations(before, r),
      ...requirementAnimations(next, r),
    ].map((a) => a.animationId),
  );
  const allowed = (a: MotionState["animations"][number]) =>
    own(a) &&
    (allEdits
      ? r.techniques.includes(a.effect as (typeof r.techniques)[number]) ||
        permittedIds.has(a.animationId)
      : permittedIds.has(a.animationId) ||
        channels(a).some((c) => writes.has(c)) ||
        (r.techniques.includes("trimPath") &&
          /reveal|ribbon|trim/i.test(a.animationId) &&
          channels(a).some((c) => c.startsWith("scale"))));
  const baseline = structuredClone(before);
  if (r.kind === "objectAnimation" && baseline.staticObjects?.some(o => o.logicalObjectId === r.target.logicalObjectId) && !next.staticObjects?.some(o => o.logicalObjectId === r.target.logicalObjectId))
    baseline.staticObjects = baseline.staticObjects.filter(o => o.logicalObjectId !== r.target.logicalObjectId);
  if (plan.timelineExtension !== "fixed" && before.settings.timelineExtensionPolicy !== "fixed" && next.settings.durationFrames > before.settings.durationFrames &&
      next.settings.durationFrames === requiredProjectFrames({ ...next, settings: { ...next.settings, durationFrames: before.settings.durationFrames } }))
    { baseline.settings.durationFrames = next.settings.durationFrames; baseline.settings.tailPolicy = next.settings.tailPolicy; }
  const originDelta =
    (next.blocks[0]?.startFrame ?? 0) - (before.blocks[0]?.startFrame ?? 0);
  if (originDelta > 0) {
    baseline.settings.durationFrames += originDelta;
    for (const b of baseline.blocks) b.startFrame += originDelta;
    for (const a of baseline.animations)
      if (!allowed(a)) a.startFrame += originDelta;
    for (const t of baseline.objectTransitions ?? []) t.startFrame += originDelta;
  }
  baseline.animations = [
    ...before.animations.filter((a) => !allowed(a)),
    ...next.animations.filter(allowed),
  ];
  const allowedIds = new Set(
    [
      ...before.animations.filter(allowed),
      ...next.animations.filter(allowed),
    ].map((a) => a.animationId),
  );
  const transitionIds = new Set((before.objectTransitions ?? []).filter(t => r.techniques.includes("objectStateTransition") && t.logicalObjectId === r.target.logicalObjectId).map(t => t.transitionId));
  const createdTransitionIds=new Set((next.objectTransitions??[]).filter(t=>r.kind==="objectAnimation"&&r.techniques.includes("objectStateTransition")&&t.logicalObjectId===r.target.logicalObjectId&&!(before.objectTransitions??[]).some(old=>old.transitionId===t.transitionId)&&(!r.parameters.fromSceneId||r.parameters.fromSceneId===t.fromSceneId)&&(!r.parameters.toSceneId||r.parameters.toSceneId===t.toSceneId)).map(t=>t.transitionId));
  const exprAllowed = (e: NonNullable<MotionState["expressions"]>[number]) =>
    (own(e) &&
    (!r.expressionIds || r.expressionIds.includes(e.expressionId)) &&
    (r.techniques.includes(e.type as (typeof r.techniques)[number]) ||
      ("sourceAnimationId" in e && allowedIds.has(e.sourceAnimationId)))) || Boolean(e.transitionId && transitionIds.has(e.transitionId) &&
      (r.effectOperation?.action !== "remove" || r.dependentPolicy === "removeDependents")) || Boolean(e.transitionId&&createdTransitionIds.has(e.transitionId)&&r.techniques.includes(e.type as IntentRequirement["techniques"][number]));
  if (originDelta > 0) {
    for (const e of baseline.expressions ?? [])
      if (!exprAllowed(e)) e.startFrame += originDelta;
  }
  baseline.expressions = [
    ...(before.expressions ?? []).filter((e) => !exprAllowed(e)),
    ...(next.expressions ?? []).filter(exprAllowed),
  ];
  // A base edit may retime its dependents, never rewrite their parameters.
  baseline.expressions = (baseline.expressions ?? []).flatMap(e => {
    if (!e.transitionId || !transitionIds.has(e.transitionId) || r.techniques.includes(e.type as IntentRequirement["techniques"][number])) return [e];
    const old = before.expressions?.find(x => x.expressionId === e.expressionId);
    if (!old) return [];
    if (r.effectOperation?.action === "remove" && r.dependentPolicy === "removeDependents") return [];
    const from = before.objectTransitions?.find(t => t.transitionId === e.transitionId), to = next.objectTransitions?.find(t => t.transitionId === e.transitionId);
    return [{ ...old, startFrame: old.type === "inertialOvershoot" && from && to ? old.startFrame + to.startFrame + to.durationFrames - from.startFrame - from.durationFrames : old.startFrame }];
  });
  baseline.timingDependencies = [
    ...(before.timingDependencies ?? []).filter(
      (d) =>
        !allowedIds.has(d.animationId) &&
        !(
          r.effectOperation?.action === "remove" &&
          allowedIds.has(d.anchorAnimationId)
        ),
    ),
    ...(next.timingDependencies ?? []).filter(
      (d) =>
        allowedIds.has(d.animationId) ||
        (r.effectOperation?.action === "remove" &&
          allowedIds.has(d.anchorAnimationId)),
    ),
  ];
  if (r.techniques.includes("objectStateTransition")) {
    const allowedTransition = (
      t: NonNullable<MotionState["objectTransitions"]>[number],
    ) =>
      t.logicalObjectId === r.target.logicalObjectId &&
      (r.parameters.fromSceneId?t.fromSceneId===r.parameters.fromSceneId:[t.fromSceneId, t.toSceneId].includes(r.sceneId!)) &&
      (!r.parameters.toSceneId || t.toSceneId === r.parameters.toSceneId);
    baseline.objectTransitions = [
      ...(before.objectTransitions ?? []).filter((t) => !allowedTransition(t)),
      ...(next.objectTransitions ?? []).filter(allowedTransition),
    ];
  }
  const allowedOrigin = (origin:NonNullable<MotionState["timingOrigins"]>[number]) =>
    origin.entity === "animation" ? allowedIds.has(origin.id) :
    origin.entity === "expression" ? [...(before.expressions??[]),...(next.expressions??[])].some(e=>e.expressionId===origin.id&&exprAllowed(e)) :
    origin.entity === "transition" ? [...(before.objectTransitions??[]),...(next.objectTransitions??[])].some(t=>t.transitionId===origin.id&&t.logicalObjectId===r.target.logicalObjectId&&r.techniques.includes("objectStateTransition")) :
    origin.entity === "dependency" ? [...(baseline.timingDependencies??[])].some(d=>d.dependencyId===origin.id&&allowedIds.has(d.animationId)) : false;
  if(before.timingOrigins || next.timingOrigins) baseline.timingOrigins=[...(before.timingOrigins??[]).filter(o=>!allowedOrigin(o)),...(next.timingOrigins??[]).filter(allowedOrigin)];
  const scoped = structuredClone(baseline);
  resolveTimingDependencies(scoped);
  reanchorExpressions(scoped, before, new Set((scoped.expressions ?? []).filter(exprAllowed).map(e=>e.expressionId)));
  refreshTimingOrigins(before,scoped,new Set((scoped.timingOrigins??[]).filter(allowedOrigin).map(o=>o.entity+":"+o.id)));
  materializeRules(scoped,project);
  const canonical = (s: MotionState) => ({
    ...s,
    ...(s.timingOrigins?{timingOrigins:[...s.timingOrigins].sort((a,b)=>(a.entity+a.id).localeCompare(b.entity+b.id))}:{}),
    expressions: [...(s.expressions ?? [])].sort((a, b) =>
      a.expressionId.localeCompare(b.expressionId),
    ),
    timingDependencies: [...(s.timingDependencies ?? [])].sort((a, b) =>
      a.dependencyId.localeCompare(b.dependencyId),
    ),
    animations: [...s.animations].sort((a, b) =>
      a.animationId.localeCompare(b.animationId),
    ),
  });
  if (!isDeepStrictEqual(canonical(scoped), canonical(next)))
    throw Object.assign(new Error(
      "TASK_SCOPE_VIOLATION: operations modify targets/techniques outside this requirement; fade and timing allowed only where present in contract",
    ), {scopeDiff:motionDiff(canonical(scoped),canonical(next))});
}
export function requirementChecks(
  state: MotionState,
  r: IntentRequirement,
  plan: IntentPlan,
  previous?: MotionState,
  committed: MotionState | undefined = previous,
) {
  if(r.semanticEdit){const edit=r.semanticEdit;const changed=!isDeepStrictEqual(state.motionRules,previous?.motionRules)||!isDeepStrictEqual(state.expressions,previous?.expressions);const applied=edit.operation==="REMOVE_RULE"?!state.motionRules?.some(rule=>rule.ruleId===edit.ruleId):changed||state.motionRules?.some(rule=>rule.sourceText===r.sourceText);return [{name:"semanticEditApplied",requirementId:r.requirementId,status:applied?"PASSED":"FAILED"}];}
  if (r.techniques.includes("objectStateTransition")) {
    const matches = (state.objectTransitions ?? []).filter(t => t.logicalObjectId === r.target.logicalObjectId && (r.parameters.fromSceneId?t.fromSceneId===r.parameters.fromSceneId:[t.fromSceneId, t.toSceneId].includes(r.sceneId!)) && (!r.parameters.toSceneId || t.toSceneId === r.parameters.toSceneId));
    if (r.effectOperation?.action === "remove") return [{ name: "stateTransitionRemoved", requirementId: r.requirementId, status: matches.length === 0 ? "PASSED" : "FAILED" }];
    return [{ name: "stateTransitionContract", requirementId: r.requirementId, status: matches.length === 1 && (r.timing.startSeconds == null || matches[0].startFrame === Math.round(r.timing.startSeconds * state.settings.fps)) && (r.parameters.easing == null || JSON.stringify(matches[0].easing) === JSON.stringify(r.parameters.easing)) && (r.parameters.durationSeconds == null || matches[0].durationFrames === Math.round(r.parameters.durationSeconds * state.settings.fps)) ? "PASSED" : "FAILED" }];
  }
  if (
    r.effectOperation?.storage === "animation" &&
    r.effectOperation.action === "remove"
  ) {
    const ids = r.animationIds ?? [];
    return [
      {
        name: "existingAnimationRemoved",
        requirementId: r.requirementId,
        status:
          ids.length &&
          ids.every((id) => !state.animations.some((a) => a.animationId === id))
            ? "PASSED"
            : "FAILED",
      },
    ];
  }
  if (r.expressionAction === "remove") {
    const ids =
      r.expressionIds ??
      previous?.expressions
        ?.filter(
          (e) =>
            e.sceneId === r.sceneId &&
            e.targetId === r.target.sourceNodeId &&
            r.techniques.includes(
              e.type as IntentRequirement["techniques"][number],
            ),
        )
        .map((e) => e.expressionId) ??
      [];
    return [
      {
        name: "existingExpressionRemoved",
        requirementId: r.requirementId,
        status:
          ids.length &&
          ids.every(
            (id) => !state.expressions?.some((e) => e.expressionId === id),
          )
            ? "PASSED"
            : "FAILED",
      },
    ];
  }
  if (r.effectOperation?.action === "enable" || r.effectOperation?.action === "disable") {
    const enabled = r.effectOperation.action === "enable";
    const ids = r.effectOperation.storage === "animation" ? r.animationIds ?? [] : r.expressionIds ?? previous?.expressions?.filter(e => e.sceneId === r.sceneId && e.targetId === r.target.sourceNodeId && r.techniques.includes(e.type as (typeof r.techniques)[number])).map(e => e.expressionId) ?? [];
    const actual = r.effectOperation.storage === "animation" ? state.animations.filter(a => ids.includes(a.animationId)) : state.expressions?.filter(e => ids.includes(e.expressionId)) ?? [];
    return [{ name: "effectEnabledState", requirementId: r.requirementId, status: ids.length > 0 && actual.length === ids.length && actual.every(e => e.enabled === enabled) ? "PASSED" : "FAILED" }];
  }
  // Disabled tracks remain editable; presence checks must not imply enabling or visible playback.
  const presenceState =
    r.effectOperation?.storage === "animation"
      ? {
          ...state,
          animations: state.animations.map((a) =>
            r.animationIds?.includes(a.animationId)
              ? { ...a, enabled: true }
              : a,
          ),
        }
      : state;
  const checkState = r.effectOperation?.storage === "expression" ? { ...presenceState, expressions: presenceState.expressions?.map(e => e.sceneId === r.sceneId && e.targetId === r.target.sourceNodeId && r.techniques.includes(e.type as (typeof r.techniques)[number]) && (!r.expressionIds || r.expressionIds.includes(e.expressionId)) ? { ...e, enabled: true } : e) } : presenceState;
  const checks = validateRequirement(checkState, r).map((c) => ({
    ...c,
    requirementId: r.requirementId,
  }));
  if (
    r.kind === "sceneTiming" ||
    r.kind === "unsupported" ||
    r.unresolvedReason
  )
    return checks;
  if (r.parameters.text) {
    const tracks = requirementAnimations(state, r).filter((a) =>
      r.techniques.includes(
        a.effect as IntentRequirement["techniques"][number],
      ),
    );
    checks.push({
      name: "textSegmentationContract",
      requirementId: r.requirementId,
      status:
        tracks.length > 0 &&
        tracks.every((a) =>
          isDeepStrictEqual(
            a.text,
            resolveTextSettings(
              r.parameters.text!,
              state.settings.fps,
              Math.max(
                1,
                Math.round(
                  (r.parameters.durationSeconds ?? 0.7) * state.settings.fps,
                ),
              ),
            ),
          ),
        )
          ? "PASSED"
          : "FAILED",
    });
  }
  if (r.kind === "editAnimation" && previous) {
    const ownEdit = (a: { sceneId: string; targetId: string }) =>
      a.sceneId === r.sceneId && a.targetId === r.target.sourceNodeId;
    const changed =
      JSON.stringify(previous.animations.filter(ownEdit)) !==
        JSON.stringify(state.animations.filter(ownEdit)) ||
      JSON.stringify(previous.expressions?.filter(ownEdit) ?? []) !==
        JSON.stringify(state.expressions?.filter(ownEdit) ?? []);
    checks.push({
      name: "editHasEffect",
      requirementId: r.requirementId,
      status:
        changed ||
        (r.effectOperation?.storage === "expression" && r.effectOperation.action === "update") ||
        r.timing.reference ||
        r.timing.anchorRequirementId ||
        r.timing.startSeconds !== null ||
        r.timing.delaySeconds !== 0 ||
        r.timing.offsetFrames != null ||
        r.effectOperation?.action === "updateTiming"
          ? "PASSED"
          : "FAILED",
    });
    const prior = requirementAnimations(previous, r);
    for (const old of prior) {
      const now = state.animations.find(
        (a) => a.animationId === old.animationId,
      );
      checks.push({
        name: "editIdentityAndFactor",
        requirementId: r.requirementId,
        status:
          now &&
          (r.timing.reference ||
            r.timing.anchorRequirementId ||
            r.timing.startSeconds !== null ||
            r.timing.delaySeconds !== 0 ||
            r.timing.offsetFrames != null ||
            (r.effectOperation?.action === "updateTiming" && r.timing.relation !== "unchanged") ||
            now.startFrame === old.startFrame) &&
          (r.parameters.durationFactor === null ||
            now.durationFrames ===
              Math.max(
                1,
                Math.round(old.durationFrames * r.parameters.durationFactor),
              ))
            ? "PASSED"
            : "FAILED",
      });
    }
    for (const old of previous.expressions ?? []) {
      if (
        old.sceneId !== r.sceneId ||
        old.targetId !== r.target.sourceNodeId ||
        (r.expressionIds && !r.expressionIds.includes(old.expressionId)) ||
        !r.techniques.includes(old.type as (typeof r.techniques)[number])
      )
        continue;
      const now = state.expressions?.find(
        (e) => e.expressionId === old.expressionId,
      );
      checks.push({
        name: "editAmplitudeFactor",
        requirementId: r.requirementId,
        status:
          now &&
          (r.parameters.decayFactor == null || ("decay" in old.parameters && "decay" in now.parameters && Math.abs(now.parameters.decay - old.parameters.decay * r.parameters.decayFactor) < 1e-10)) &&
          (r.parameters.frequencyFactor === null ||
            ("frequency" in old.parameters &&
              "frequency" in now.parameters &&
              Math.abs(
                now.parameters.frequency -
                  old.parameters.frequency * r.parameters.frequencyFactor,
              ) < 1e-10)) &&
          (r.parameters.amplitudeFactor === null ||
            Math.abs(
              now.parameters.amplitude -
                old.parameters.amplitude * r.parameters.amplitudeFactor,
            ) < 1e-10)
            ? "PASSED"
            : "FAILED",
      });
    }
  }
  if (
    r.techniques.includes("inertialOvershoot") &&
    r.parameters.intensity != null &&
    r.parameters.amplitude === null &&
    r.parameters.amplitudeFactor === null
  ) {
    const defaults = inertiaIntensityDefaults[r.parameters.intensity];
    const matches =
      state.expressions?.filter(
        (e) =>
          e.type === "inertialOvershoot" &&
          e.sceneId === r.sceneId &&
          e.targetId === r.target.sourceNodeId &&
          (!r.parameters.property || e.property === r.parameters.property),
      ) ?? [];
    checks.push({
      name: "qualitativeIntensity",
      requirementId: r.requirementId,
      status:
        matches.length &&
        matches.every((e) => {
          const old = previous?.expressions?.find(
            (old) => old.expressionId === e.expressionId,
          );
          const expected =
            r.kind === "editAnimation" && old
              ? (old.parameters.amplitude * defaults.amplitude) /
                inertiaIntensityDefaults.normal.amplitude
              : defaults.amplitude;
          return Math.abs(e.parameters.amplitude - expected) < 1e-10;
        })
          ? "PASSED"
          : "FAILED",
    });
  }
  const base = state.animations.filter(
    (a) =>
      a.enabled &&
      a.sceneId === r.sceneId &&
      a.targetId === r.target.sourceNodeId,
  );
  for (const t of r.techniques) {
    const a = base.find((a) => a.effect === t);
    if (a && t.startsWith("slide"))
      checks.push({
        name: "entranceDirection",
        requirementId: r.requirementId,
        status:
          "mode" in a.parameters &&
          a.parameters.mode === (r.techniques.includes("fadeOut") ? "out" : "in") &&
          a.parameters.distance > 0
            ? "PASSED"
            : "FAILED",
      });
    if (a && t === "fadeIn")
      checks.push({
        name: "fadeEndpoints",
        requirementId: r.requirementId,
        status:
          a.effect === "fadeIn" &&
          a.parameters.from === 0 &&
          a.parameters.to === 1
            ? "PASSED"
            : "FAILED",
      });
  }
  const related = requirementAnimations(state, r);
  for (const a of related) {
    const ok =
      (r.parameters.durationSeconds === null ||
        a.durationFrames ===
          Math.max(
            1,
            Math.round(
              r.parameters.durationSeconds *
                state.settings.fps *
                (r.parameters.durationFactor ?? 1),
            ),
          )) &&
      (r.parameters.easing === null ||
        JSON.stringify(a.easing) === JSON.stringify(r.parameters.easing)) &&
      (r.parameters.distance === null ||
        !a.effect.startsWith("slide") ||
        ("distance" in a.parameters &&
          a.parameters.distance === r.parameters.distance)) &&
      (a.effect !== "moveTo" ||
        ((r.parameters.x === null || a.parameters.toX === r.parameters.x) &&
          (r.parameters.y === null || a.parameters.toY === r.parameters.y))) &&
      ((a.effect !== "scaleIn" && a.effect !== "scaleOut") ||
        ((r.parameters.scaleFrom === null ||
          a.parameters.from === r.parameters.scaleFrom) &&
          (r.parameters.scaleTo === null ||
            a.parameters.to === r.parameters.scaleTo))) &&
      (r.parameters.direction === null ||
        (a.effect !== "trimPath" && a.effect !== "maskReveal") ||
        a.parameters.direction === r.parameters.direction);
    checks.push({
      name: "explicitParameters",
      requirementId: r.requirementId,
      status: ok ? "PASSED" : "FAILED",
    });
  }
  const primary =
      related.find((a) => !a.effect.startsWith("fade")) ?? related[0],
    block = state.blocks.map(b=>({...b,startFrame:state.sceneAnchors?.find(a=>a.sceneId===b.sceneId)?.startFrame ?? b.startFrame})).find((b) => b.sceneId === r.sceneId);
  if (
    primary &&
    block &&
    (r.kind !== "editAnimation" ||
      r.timing.reference ||
      r.timing.anchorRequirementId ||
      r.timing.startSeconds !== null ||
      (r.effectOperation?.action === "updateTiming" && r.timing.relation !== "unchanged"))
  ) {
    const anchorReq = plan.requirements.find(
      (x) => x.requirementId === r.timing.anchorRequirementId,
    );
    const anchor = r.timing.reference
      ? state.animations.find(
          (a) => a.animationId === r.timing.reference!.resolvedAnimationId,
        )
      : requirementAnchor(state, anchorReq);
    const isSelfAnchor = Boolean(
      r.timing.reference?.endpoint !== "end" &&
        ((r.timing.reference &&
          (related.some(
            (a) => a.animationId === r.timing.reference!.resolvedAnimationId,
          ) ||
            Boolean(
              r.timing.reference.resolvedAnimationId &&
                r.animationIds?.includes(r.timing.reference.resolvedAnimationId),
            ))) ||
          (anchor && related.some((a) => a.animationId === anchor.animationId))),
    );
    const delay =
      r.timing.offsetFrames ??
      Math.round(r.timing.delaySeconds * state.settings.fps);
    const prevAnchor =
      committed?.animations.find(
        (a) => a.animationId === r.timing.reference?.resolvedAnimationId,
      ) ??
      committed?.animations.find((a) => a.animationId === primary.animationId);
    const expected = isSelfAnchor || (r.kind === "editAnimation" && !r.timing.reference && !r.timing.anchorRequirementId && r.timing.startSeconds === null && r.timing.relation === "unchanged")
      ? (prevAnchor?.startFrame ?? primary.startFrame - delay) + delay
      : r.timing.reference
        ? anchor!.startFrame +
          (r.timing.reference.endpoint === "end" ? anchor!.durationFrames : 0) +
          delay
        : r.timing.startSeconds !== null
          ? Math.round(r.timing.startSeconds * state.settings.fps) + delay
          : r.timing.relation === "sceneStart"
            ? block.startFrame + delay
            : anchor
              ? r.timing.relation === "afterRequirement"
                ? anchor.startFrame + anchor.durationFrames + delay
                : r.timing.relation === "withRequirement"
                  ? anchor.startFrame + delay
                  : r.timing.relation === "beforeRequirement"
                    ? anchor.startFrame - primary.durationFrames + delay
                    : null
              : r.timing.relation === "sceneEnd"
                ? block.startFrame +
                  block.durationFrames -
                  primary.durationFrames +
                  delay
                : null;
    if (expected !== null)
      checks.push({
        name: "requirementTiming",
        requirementId: r.requirementId,
        status: related.every(
          (a) =>
            a.startFrame - (r.timing.align !== "end" ? (committed?.animations.find(old=>old.animationId===a.animationId)?.startFrame ?? primary.startFrame) - (committed?.animations.find(old=>old.animationId===primary.animationId)?.startFrame ?? primary.startFrame) : 0) +
              (r.timing.align === "end" && r.timing.relation !== "sceneEnd"
                ? a.durationFrames
                : 0) ===
            expected,
        )
          ? "PASSED"
          : "FAILED",
      });
    if ((r.timing.anchorRequirementId || r.timing.reference) && !isSelfAnchor)
      checks.push({
        name: "persistedTemporalDependency",
        requirementId: r.requirementId,
        status: state.timingDependencies?.some(
          (d) =>
            d.animationId === primary.animationId &&
            d.anchorAnimationId === anchor?.animationId,
        )
          ? "PASSED"
          : "FAILED",
      });
  }
  for (const e of (state.expressions ?? []).filter(
    (e) =>
      e.enabled &&
      e.sceneId === r.sceneId &&
      e.targetId === r.target.sourceNodeId &&
      r.techniques.includes(e.type as (typeof r.techniques)[number]),
  )) {
    if (r.parameters.property && e.property !== r.parameters.property) continue;
    const ok =
      (r.parameters.amplitude === null ||
        e.parameters.amplitude === r.parameters.amplitude) &&
      (r.parameters.frequency === null ||
        !("frequency" in e.parameters) ||
        e.parameters.frequency === r.parameters.frequency) &&
      (r.parameters.decay === null || ("decay" in e.parameters && e.parameters.decay === r.parameters.decay)) &&
      (e.type !== "wiggle" ||
        r.parameters.seed == null ||
        e.parameters.seed === r.parameters.seed);
    checks.push({
      name: "expressionParameters",
      requirementId: r.requirementId,
      status: ok ? "PASSED" : "FAILED",
    });
    if (e.type === "wiggle" && r.targetScope === "logicalObject" && (r.kind !== "editAnimation" || r.parameters.lifetime != null || r.parameters.durationSeconds != null)) {
      const expectedEnd = r.parameters.lifetime === "scene" ? (block ? block.startFrame + block.durationFrames : -1)
        : r.parameters.lifetime === "transition" ? state.objectTransitions?.find(t => t.transitionId === e.transitionId)?.startFrame! + state.objectTransitions?.find(t => t.transitionId === e.transitionId)?.durationFrames!
        : r.parameters.durationSeconds != null ? e.startFrame + Math.round(r.parameters.durationSeconds * state.settings.fps) : state.settings.durationFrames;
      checks.push({ name: "requestedLogicalEffectScope", requirementId: r.requirementId,
        status: e.ownership?.scope === "logicalObject" && e.ownership.logicalObjectId === r.target.logicalObjectId && e.startFrame + e.durationFrames === expectedEnd ? "PASSED" : "FAILED" });
    }
    if (e.type === "wiggle" && r.kind !== "editAnimation") {
      const expected =
        r.timing.startSeconds !== null
          ? Math.round(r.timing.startSeconds * state.settings.fps)
          : e.ownership?.scope === "logicalObject" && r.parameters.lifetime !== "scene" ? 0 : block?.startFrame;
      if (r.timing.relation === "sceneStart" && expected !== undefined)
        checks.push({
          name: "expressionTiming",
          requirementId: r.requirementId,
          status:
            e.startFrame ===
            expected + Math.round(r.timing.delaySeconds * state.settings.fps)
              ? "PASSED"
              : "FAILED",
        });
    }
  }
  if (r.techniques.includes("inertialOvershoot")) {
    const e = state.expressions?.find(
      (e) =>
        e.enabled &&
        e.type === "inertialOvershoot" &&
        e.sceneId === r.sceneId &&
        e.targetId === r.target.sourceNodeId,
    );
    const source =
      e && "sourceAnimationId" in e
        ? state.animations.find((a) => a.animationId === e.sourceAnimationId) ?? state.objectTransitions?.find(t => t.transitionId === e.transitionId && t.transitionId === e.sourceAnimationId)
        : undefined;
    checks.push({
      name: "afterPosition",
      requirementId: r.requirementId,
      status:
        e &&
        source &&
        e.startFrame === source.startFrame + source.durationFrames &&
        ["x", "y"].includes(e.property)
          ? "PASSED"
          : "FAILED",
    });
  }
  return checks;
}
export async function runIntentTasks(
  project: LoadedProject,
  initial: MotionState,
  input: IntentPlan,
  hooks: {
    repair: (
      context: unknown,
      request: string,
      task: IntentTask,
      attempt: number,
    ) => Promise<unknown>;
    verify: (
      task: IntentTask,
      next: MotionState,
      before: MotionState,
      attempt: number,
    ) => Promise<{ status: string; checks?: unknown[] }>;
    commit: (
      task: IntentTask,
      plan: Plan,
      next: MotionState,
    ) => Promise<MotionState>;
    trace: (tasks: IntentTask[], entry?: unknown) => Promise<void>;
    checkpoint?: () => void;
    maxAttempts?: number;
    preparedPlans?: Map<string, { beforeDigest: string; compiled: Plan }>;
  },
) {
  const preflightStarted = performance.now();
  const plan = expandInheritance(input),
    tasks = compileTasks(project, plan, initial),
    pending = tasks.filter((t) => t.status === "PENDING"),
    plans: Plan[] = [];
  let current = initial;
  const taskBefore = new Map<string, MotionState>();
  await hooks.trace(tasks);
  while (pending.length) {
    hooks.checkpoint?.();
    const i = pending.findIndex((t) =>
      t.dependencies.every(
        (id) =>
          tasks.find((other) => other.taskId === id)?.status !== "PENDING" &&
          tasks.find((other) => other.taskId === id)?.status !== "RUNNING",
      ),
    );
    if (i < 0) {
      for (const task of pending) {
        task.status = "BLOCKED";
        task.error = "TEMPORAL_DEPENDENCY_CYCLE";
      }
      break;
    }
    const [task] = pending.splice(i, 1);
    if (
      task.dependencies.some(
        (id) => tasks.find((t) => t.taskId === id)?.status !== "PASSED",
      )
    ) {
      task.status = "BLOCKED";
      task.error = "DEPENDENCY_FAILED";
      await hooks.trace(tasks);
      continue;
    }
    task.status = "RUNNING";
    const before = current;
    taskBefore.set(task.taskId, before);
    let feedback: unknown,
      previousCandidate: unknown,
      previousSignature = "";
    for (let attempt = 1; attempt <= (hooks.maxAttempts ?? 3); attempt++) {
      task.qaResult = undefined;
      task.validationResult = undefined;
      let generated: Plan | undefined;
      hooks.checkpoint?.();
      try {
        if (attempt === 1) {
          try {
            const prepared = hooks.preparedPlans?.get(task.taskId);
            task.compilationSource = prepared?.beforeDigest === motionStateDigest(current) ? "validated-preflight" : "compiled";
            generated = task.compilationSource === "validated-preflight"
              ? structuredClone(prepared!.compiled)
              : compileRequirement(project, current, plan, task, initial);
          } catch (error) {
            throw new Error("COMPILER_COVERAGE_ERROR: " + String(error));
          }
        } else
          generated = parsePlan(
            await hooks.repair(
              taskRepairContext(project, current, plan, task, feedback),
              task.userIntent,
              task,
              attempt,
            ),
          );
        if (generated.status !== "ready" || !generated.operations.length)
          throw new Error("Requirement produced no executable operations");
        task.generatedOperations = generated.operations;
        let next: MotionState;
        let checks: ReturnType<typeof requirementChecks>;
        try {
          ({ next, checks } = admitCompiledTask(project, current, plan, task, generated, initial));
        } catch (error) {
          throw new Error(
            (attempt === 1
              ? "OPERATION_VALIDATION_ERROR: "
              : "MODEL_OPERATION_VALIDATION_ERROR: ") + String(error),
          );
        }

        task.generatedOperations = generated.operations;
        task.validationResult = {
          status: checks.some((c) => c.status === "FAILED")
            ? "FAILED"
            : "PASSED",
          checks,
        };
        task.operationCoverage = {
          expectedActions: plan.requirements
            .filter((r) => task.requirementIds.includes(r.requirementId))
            .flatMap((r) => [
              ...r.techniques.map((technique) => ({
                technique,
                action:
                  r.effectOperation?.action === "remove"
                    ? r.effectOperation.storage === "animation"
                      ? "removeAnimation"
                      : "removeExpression"
                    : semanticBindings[technique] === "expression"
                      ? current.expressions?.some(
                          (e) =>
                            e.sceneId === r.sceneId &&
                            e.targetId === r.target.sourceNodeId &&
                            e.type === technique,
                        )
                        ? "updateExpression"
                        : "createExpression"
                      : semanticBindings[technique] === "easing"
                        ? "updateEasing"
                        : r.kind === "editAnimation"
                          ? "updateAnimation"
                          : "create required effect",
              })),
              ...Object.entries(r.parameters)
                .filter(
                  ([key, value]) =>
                    value != null &&
                    [
                      "easing",
                      "durationSeconds",
                      "durationFactor",
                      "amplitude",
                      "amplitudeFactor",
                      "frequency",
                      "frequencyFactor",
                      "direction",
                      "x",
                      "y",
                      "scaleFrom",
                      "scaleTo",
                      "intensity",
                    ].includes(key),
                )
                .map(([parameter, value]) => ({ parameter, value })),
            ]),
          compiledActions: generated.operations.map((op) => ({
            type: op.type,
            ...(op.type === "updateAnimation" || op.type === "addAnimation"
              ? {
                  animationId: op.animation.animationId,
                  effect: op.animation.effect,
                }
              : op.type === "setExpression"
                ? {
                    expressionId: op.expression.expressionId,
                    effect: op.expression.type,
                  }
                : {}),
          })),
          missing: checks.filter((c) => c.status === "FAILED"),
          status: checks.some((c) => c.status === "FAILED")
            ? "FAILED"
            : "PASSED",
        };
        if (checks.some((c) => c.status === "FAILED"))
          throw new Error(
            (attempt === 1
              ? "COMPILER_COVERAGE_ERROR: "
              : "INTENT_REQUIREMENT_MISMATCH: ") +
              JSON.stringify(checks.filter((c) => c.status === "FAILED")),
          );
        hooks.checkpoint?.();
        const qa = await hooks.verify(task, next, current, attempt);
        task.qaResult = qa;
        task.repairHistory.push({
          attempt,
          operations: generated.operations,
          validation: task.validationResult,
          qa,
        });
        if (!qaAdmission(qa).accepted)
          throw new Error(
            infrastructureFailure(
              qa as { checks?: { status: string; reason?: string }[] },
            )
              ? "RENDER_INFRASTRUCTURE_FAILED: " +
                JSON.stringify((qa as { checks?: unknown[] }).checks)
              : "MOTION_QA_FAILED",
          );
        hooks.checkpoint?.();
        current = await hooks.commit(task, generated, next);
        task.status = "PASSED";
        plans.push(generated);
        break;
      } catch (error) {
        type FailureCheck = {
          status: string;
          name: string;
          reason?: string;
          metrics?: unknown;
        };
        const failedChecks = [
          ...((task.qaResult as { checks?: FailureCheck[] })?.checks ?? []),
          ...((task.validationResult as { checks?: FailureCheck[] })?.checks ??
            []),
        ]
          .filter((c) => c.status === "FAILED")
          .map((c) => ({
            name: c.name,
            reason: c.reason,
            metrics:
              c.name === "realPathGeometry"
                ? "See local geometry report"
                : c.metrics,
          }));
        const failureReason =
            (error instanceof Error &&
            "code" in error &&
            error.code === "STALE_PROJECT_REVISION"
              ? "STALE_PROJECT_REVISION: "
              : "") + String(error),
          signature = JSON.stringify({
            failureReason,
            failedChecks,
            operations: generated?.operations,
          });
        task.primaryFailureReason ??= failureReason;
        feedback = {
          failureCategory: failureCategory(failureReason),
          taskId: task.taskId,
          requirementIds: task.requirementIds,
          targetId: task.targetReference.targetId,
          expectedTechnique: task.techniqueId,
          expectedTechniques: task.techniques,
          actualTechnique: generated?.operations.flatMap((op) =>
            op.type === "addAnimation" || op.type === "updateAnimation"
              ? [op.animation.effect]
              : op.type === "setExpression"
                ? [op.expression.type]
                : [],
          ),
          actualOperations: generated?.operations,
          failureReason,
          failedChecks,
          availableCapabilities: {
            techniques: task.techniques,
            sceneInterval: current.blocks.find(
              (b) => b.sceneId === task.targetReference.sceneId,
            ),
          },
          allowedRepairActions: [
            "change parameters of this requirement only",
            "preserve all requested techniques",
            "preserve explicit starts and dependencies",
            "do not change other requirements",
          ],
          previousResponse: generated ?? previousCandidate,
          operationCoverage: task.operationCoverage,
        };
        task.repairHistory.push({ attempt, feedback });
        await hooks.trace(tasks, { status: "repair", feedback });
        if (
          failureCategory(failureReason) !== "animation-validation" ||
          signature === previousSignature ||
          attempt === (hooks.maxAttempts ?? 3) ||
          /COMPILER_COVERAGE_ERROR|UNSUPPORTED_COMPOUND_EDIT|^Error: OPERATION_VALIDATION_ERROR|BUDGET|CANCELLED|authentication|timeout|aborted|401|403|login|Исходный дизайн|Анимация уже изменилась/i.test(
            failureReason,
          )
        ) {
          task.status = "FAILED";
          task.error =
            task.primaryFailureReason === failureReason
              ? failureReason
              : task.primaryFailureReason +
                "; repair stopped: " +
                failureReason;
          break;
        }
        previousSignature = signature;
        previousCandidate = generated;
      }
    }
    await hooks.trace(tasks);
  }
  const requirements = plan.requirements.map((r) => {
    const task = tasks.find((t) => t.requirementIds.includes(r.requirementId))!;
    const checks = requirementChecks(
      current,
      r,
      plan,
      taskBefore.get(task.taskId),
      initial,
    );
    const persisted =
      task.status === "PASSED" && checks.every((c) => c.status === "PASSED");
    return {
      ...r,
      status: persisted
        ? "PASSED"
        : task.status === "PASSED"
          ? "FAILED"
          : task.status,
      taskId: task.taskId,
      checks,
      qaResult: task.qaResult,
      error: task.error,
    };
  });
  const completed = requirements.filter((r) => r.status === "PASSED").length;
  const semanticActionIds = [
    ...new Set(
      plan.requirements.map(
        (r) =>
          r.semanticActionId ?? r.selectionRequirementId ?? r.requirementId,
      ),
    ),
  ];
  const completedActions = semanticActionIds.filter((id) =>
    requirements
      .filter(
        (r) =>
          (r.semanticActionId ??
            r.selectionRequirementId ??
            r.requirementId) === id,
      )
      .every((r) => r.status === "PASSED"),
  ).length;
  const reconciliation = {
    semanticActionCount: semanticActionIds.length,
    completedSemanticActionCount: completedActions,
    userIntentCount: new Set(
      plan.requirements.map(
        (r) =>
          r.semanticActionId ?? r.selectionRequirementId ?? r.requirementId,
      ),
    ).size,
    selectedObjectCount: new Set(plan.requirements.flatMap(r=>r.semanticEdit ? resolveRuleTargets(project,r.semanticEdit.targets.length?r.semanticEdit.targets:r.semanticEdit.scope.logicalObjectIds) : r.target.sourceNodeId?[r.sceneId+"/"+r.target.sourceNodeId]:[])).size,
    selectedAnimationCount: new Set(
      plan.requirements.flatMap((r) => r.animationIds ?? []),
    ).size,
    selectedExpressionCount: new Set(
      plan.requirements.flatMap((r) => {
        if(!r.semanticEdit)return r.expressionIds??[];
        const ids=resolveRuleTargets(project,r.semanticEdit.targets.length?r.semanticEdit.targets:r.semanticEdit.scope.logicalObjectIds);
        const objects=ruleObjects(project).filter(o=>r.semanticEdit!.scope.selector==='project'||ids.includes(o.logicalObjectId));
        return [...(initial.expressions??[]),...(current.expressions??[])].filter(e=>e.type===r.semanticEdit!.effect && objects.some(o=>e.ownership?.logicalObjectId===o.logicalObjectId||o.sourceInstances.some(i=>i.sceneId===e.sceneId&&i.sourceNodeId===e.targetId))).map(e=>e.expressionId);
      }),
    ).size,
    validationLevels: {
      semantic: {
        status: "PASSED",
        basis: "validated structured intent contract",
        humanIntentCompleteness: "NOT_PROVEN",
      },
      execution:
        completed === requirements.length
          ? "PASSED"
          : completed
            ? "PARTIAL"
            : "FAILED",
      render: tasks.some(
        (t) =>
          t.qaResult && qaAdmission(t.qaResult).renderValidation === "FAILED",
      )
        ? "FAILED"
        : tasks.some(
              (t) =>
                !t.qaResult ||
                qaAdmission(t.qaResult).renderValidation === "NOT_TESTED",
            )
          ? "NOT_TESTED"
          : tasks.some(
                (t) => qaAdmission(t.qaResult).renderValidation === "WARNING",
              )
            ? "WARNING"
            : "PASSED",
      artistic: "NOT_TESTED",
    },
    requested: requirements.length,
    completed,
    qaPassed: requirements.filter(
      (r) =>
        r.status === "PASSED" &&
        (r.qaResult as { status: string })?.status === "PASSED",
    ).length,
    taskCount: tasks.length,
    operationCount: plans.reduce((n, p) => n + p.operations.length, 0),
    compiledOperationCount: tasks.reduce(
      (n, t) => n + (t.generatedOperations?.length ?? 0),
      0,
    ),
    appliedOperationCount: plans.reduce((n, p) => n + p.operations.length, 0),
    successfulRequirementCount: completed,
    status:
      completed === requirements.length
        ? "SUCCESS"
        : completed
          ? "PARTIAL_SUCCESS"
          : "FAILED",
  };
  await hooks.trace(tasks, { reconciliation, requirements });
  return {
    tasks,
    requirements,
    reconciliation,
    next: current,
    operationBatches: plans.map((p) => p.operations),
    plan: {
      status: completed ? "ready" : "unsupported",
      summary: plan.requirements.some((r) => r.semanticActionId)
        ? `Выполнено ${completedActions} из ${semanticActionIds.length} действий; ${completed} из ${requirements.length} требований.`
        : plan.requirements.some((r) => r.selectionRequirementId)
          ? `Изменено ${completed} из ${requirements.length} объектных задач. Пользовательских требований: ${reconciliation.userIntentCount}.`
          : `Выполнено ${completed} из ${requirements.length} требований.`,
      assumptions: plan.assumptions,
      warnings: requirements
        .filter((r) => r.status !== "PASSED")
        .map(
          (r) =>
            `${r.target.name ?? r.sceneId}: ${r.error ?? r.unresolvedReason ?? "Не выполнено"}`,
        )
        .slice(0, 50),
      operations: plans.flatMap((p) => p.operations),
    } as Plan,
  };
}

/** The same admission rules are used by preflight and execution. Schema/geometry writes remain in applyOperations. */
export function admitCompiledTask(project: LoadedProject, before: MotionState, plan: IntentPlan, task: IntentTask, compiled: Plan, committed: MotionState = before) {
  const next = applyOperations(before, compiled.operations, project);
  assertIntentScope(project, before, next, plan, task);
  const checks = plan.requirements.filter(r => task.requirementIds.includes(r.requirementId)).flatMap(r => requirementChecks(next, r, plan, before, committed));
  return { next, checks };
}
/** Full deterministic candidate preflight; no persistence, renderer or provider call. */
export function preflightIntentPlan(
  project: LoadedProject,
  state: MotionState,
  input: IntentPlan,
  overrides: ReadonlyMap<string, Plan> = new Map(),
) {
  const preflightStarted = performance.now();
  const plan = expandInheritance(input),
    tasks = compileTasks(project, plan, state),
    done = new Set<string>();
  let candidate = structuredClone(state);
  const reports: unknown[] = [];
  const preparedPlans = new Map<string, { beforeDigest: string; compiled: Plan }>();
  const recoveries: unknown[] = [];
  while (done.size < tasks.length) {
    const task = tasks.find(
      (t) => !done.has(t.taskId) && t.dependencies.every((id) => done.has(id)),
    );
    if (!task)
      throw Object.assign(
        new Error("INTENT_PREFLIGHT_FAILED: dependency cycle"),
        { report: { status: "FAILED", classification: "INVALID", code: "DEPENDENCY_CYCLE", reports } },
      );
    try {
      if (task.status === "BLOCKED")
        throw new Error(task.error ?? "UNSUPPORTED_REQUIREMENT");
      const compilationStarted = performance.now();
      const initial = candidate;
      let working = candidate, prefix: Plan["operations"] = [];
      let admitted: ReturnType<typeof admitCompiledTask> | undefined, compiled: Plan | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const proposed = overrides.get(task.taskId) ?? compileRequirement(project, working, plan, task, state);
          compiled = { ...proposed, operations: [...prefix, ...proposed.operations] };
          admitted = admitCompiledTask(project, initial, plan, task, compiled, state);
          break;
        } catch (error) {
          const required = error instanceof TimelineConstraintError ? error.requiredDurationFrames : error instanceof MotionToolError && error.issue.code === "TIMELINE_CONFLICT" ? Number(error.issue.details.requiredDurationFrames) : NaN;
          if (attempt === 2 || plan.timelineExtension === "fixed" || state.settings.timelineExtensionPolicy === "fixed" || !Number.isInteger(required) || required <= working.settings.durationFrames || required > 108000) throw error;
          prefix = [{ type: "setProjectSettings", settings: { ...initial.settings, durationFrames: required, tailPolicy: "holdLastScene" } }];
          working = applyOperations(initial, prefix, project);
          recoveries.push({ taskId: task.taskId, classification: "RECOVERABLE", code: "DEPENDENT_EFFECT_EXCEEDS_TIMELINE", resolution: "extendProject", previousDurationFrames: initial.settings.durationFrames, requiredDurationFrames: required, requiredAdditionalFrames: required - initial.settings.durationFrames, attempt: attempt + 1, blocksMoved: false });
        }
      }
      if (!admitted || !compiled) throw new Error("PREFLIGHT_RECOVERY_LIMIT");
      const { next, checks } = admitted;
      preparedPlans.set(task.taskId, { beforeDigest: motionStateDigest(candidate), compiled });
      if (checks.some((c) => c.status === "FAILED"))
        throw Object.assign(new Error("REQUIREMENT_OPERATIONS_INCOMPLETE"), {
          checks,
        });
      reports.push({
        compilationAndValidationMs: performance.now() - compilationStarted,
        readSet: plan.requirements
          .filter((r) => task.requirementIds.includes(r.requirementId))
          .flatMap((r) =>
            r.timing.reference?.resolvedAnimationId
              ? [r.timing.reference.resolvedAnimationId]
              : [],
          ),
        taskId: task.taskId,
        requirementIds: task.requirementIds,
        operations: compiled.operations,
        checks,
        status: "PASSED",
      });
      candidate = next;
      done.add(task.taskId);
    } catch (error) {
      throw Object.assign(
        new Error(
          `INTENT_PREFLIGHT_FAILED: ${task.targetReference.name}: ${String(error)}`,
        ),
        {
          report: {
            status: "FAILED",
            classification: error instanceof TimelineConstraintError || error instanceof MotionToolError && error.issue.code === "TIMELINE_CONFLICT" ? "RECOVERABLE" : /AMBIGUOUS|REQUIRE_POLICY/.test(String(error)) ? "AMBIGUOUS" : /UNSUPPORTED|недоступен/.test(String(error)) ? "UNSUPPORTED" : "INVALID",
            code: error instanceof TimelineConstraintError ? error.code : error instanceof MotionToolError ? error.issue.code : String(error).replace(/^Error: /, "").split(":")[0],
            affectedIds: error instanceof TimelineConstraintError ? error.affectedIds : undefined,
            availableResolutions: error instanceof TimelineConstraintError ? plan.timelineExtension === "fixed" || state.settings.timelineExtensionPolicy === "fixed" ? ["inspectDependencies", "reviseTimelineConstraint"] : ["extendProject", "adjustEffectDuration"] : error instanceof MotionToolError ? error.issue.allowedActions : [],
            requiredAdditionalFrames: error instanceof TimelineConstraintError ? error.requiredDurationFrames - error.actualDurationFrames : undefined,
            recoveries,
            taskId: task.taskId,
            reports,
            failure: String(error),
            scopeDiff:(error as {scopeDiff?:unknown}).scopeDiff,
            toolIssue: error instanceof MotionToolError ? error.issue : undefined,
            diagnostic: { target: task.targetReference, techniques: task.techniques, code: String(error).replace(/^Error: /, "").split(":")[0], invariant: String(error) },
            checks: (error as { checks?: unknown }).checks,
          },
        },
      );
    }
  }
  return {
    status: "PASSED",
    classification: "VALID",
    recoveries,
    durationMs: performance.now() - preflightStarted,
    preparedPlans,
    graphDiff: {
      before: state.timingDependencies ?? [],
      after: candidate.timingDependencies ?? [],
    },
    tasks: reports,
    operationCount: reports.reduce<number>(
      (n, r) => n + (r as { operations: unknown[] }).operations.length,
      0,
    ),
  };
}
