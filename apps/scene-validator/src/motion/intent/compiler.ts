import {
  semanticBindings,
  isCustomEasing,
} from "../../motion-library/techniques/registry.js";
import type { Easing } from "../../motion-library/easings/registry.js";
import { buildRegistry, resolveState } from "../registry.js";
import { createHash } from "node:crypto";
import type { LoadedProject } from "../../types.js";
import type {
  IntentPlan,
  IntentRequirement,
  IntentTechnique,
} from "./schema.js";
import type { MotionState, Plan, Animation } from "../schema.js";
import { channels, applyOperations } from "../operations.js";
import { objectsIn } from "../context.js";
import { resolveBaseMotion } from "../base-motion.js";
import { inertiaIntensityDefaults } from "../../motion-library/expressions/registry.js";
export interface IntentTask {
  taskId: string;
  requirementIds: string[];
  kind: "sceneTiming" | "objectAnimation" | "editAnimation" | "unsupported";
  targetReference: { sceneId: string; targetId: string; name: string };
  techniqueId: string;
  techniques: IntentTechnique[];
  status: "PENDING" | "RUNNING" | "PASSED" | "FAILED" | "BLOCKED";
  dependencies: string[];
  userIntent: string;
  generatedOperations?: Plan["operations"];
  validationResult?: unknown;
  qaResult?: unknown;
  repairHistory: unknown[];
  error?: string;
  operationCoverage?: unknown;
  primaryFailureReason?: string;
}
const stable = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);
export function expandInheritance(plan: IntentPlan) {
  const expanded = structuredClone(plan),
    done = new Set<string>();
  function expand(r: IntentRequirement) {
    if (done.has(r.requirementId)) return;
    if (r.inheritFromRequirementId) {
      const parent = expanded.requirements.find(
        (x) => x.requirementId === r.inheritFromRequirementId,
      )!;
      expand(parent);
      r.techniques = [...new Set([...parent.techniques, ...r.techniques])];
      for (const key of Object.keys(
        r.parameters,
      ) as (keyof typeof r.parameters)[])
        if (
          r.parameters[key] === null &&
          !["x", "y", "fromSceneId", "toSceneId"].includes(key)
        )
          Object.assign(r.parameters, { [key]: parent.parameters[key] });
    }
    done.add(r.requirementId);
  }
  expanded.requirements.forEach(expand);
  return expanded;
}
export function compileTasks(
  project: LoadedProject,
  input: IntentPlan,
): IntentTask[] {
  const plan = expandInheritance(input),
    tasks: IntentTask[] = [];
  const timing = plan.requirements.filter((r) => r.kind === "sceneTiming");
  if (timing.length)
    tasks.push({
      taskId: "task_" + stable(timing.map((r) => r.requirementId)),
      requirementIds: timing.map((r) => r.requirementId),
      kind: "sceneTiming",
      targetReference: { sceneId: "", targetId: "", name: "Начало сцен" },
      techniqueId: "sceneTiming",
      techniques: [],
      status: timing.some((r) => r.unresolvedReason) ? "BLOCKED" : "PENDING",
      dependencies: [],
      userIntent: timing.map((r) => r.sourceText).join("\n"),
      repairHistory: [],
      error:
        timing.find((r) => r.unresolvedReason)?.unresolvedReason ?? undefined,
    });
  for (const r of plan.requirements.filter((r) => r.kind !== "sceneTiming")) {
    const target = project.inspection.document.scenes
      .flatMap(objectsIn)
      .find(
        (o) => o.sceneId === r.sceneId && o.targetId === r.target.sourceNodeId,
      );
    const error =
      r.unresolvedReason ??
      (!target
        ? "TARGET_UNRESOLVED"
        : target.mask
          ? "MASK_TARGET"
          : r.techniques.includes("trimPath") && !target.trimSupported
            ? "MISSING_PATH_GEOMETRY: " + target.trimReason
            : undefined);
    tasks.push({
      taskId: "task_" + stable(r.requirementId),
      requirementIds: [r.requirementId],
      kind: r.kind,
      targetReference: {
        sceneId: r.sceneId ?? "",
        targetId: r.target.sourceNodeId ?? "",
        name: r.target.name ?? "Не определён объект",
      },
      techniqueId: r.techniques.join("+"),
      techniques: r.techniques,
      status: error || r.kind === "unsupported" ? "BLOCKED" : "PENDING",
      dependencies: [],
      userIntent: r.sourceText,
      repairHistory: [],
      error,
    });
  }
  for (const t of tasks) {
    if (t.kind === "sceneTiming") continue;
    const r = plan.requirements.find(
      (r) => r.requirementId === t.requirementIds[0],
    )!;
    t.dependencies = tasks
      .filter(
        (other) =>
          (other.kind === "sceneTiming" &&
            timing.some((x) => x.sceneId === r.sceneId)) ||
          other.requirementIds.includes(r.timing.anchorRequirementId ?? ""),
      )
      .map((other) => other.taskId);
  }
  return tasks;
}
/** Pick one existing base for a standalone easing edit; explicit effect/property always wins. */
export function requirementAnimations(
  state: MotionState,
  r: IntentRequirement,
): Animation[] {
  const own = state.animations.filter(
    (a) =>
      a.enabled &&
      a.sceneId === r.sceneId &&
      a.targetId === r.target.sourceNodeId,
  );
  const effects = r.techniques.filter(
    (t) => semanticBindings[t] === "animation",
  );
  if (effects.length)
    return own.filter((a) => effects.includes(a.effect as IntentTechnique));
  if (
    !r.techniques.some((t) => semanticBindings[t] === "easing") &&
    r.parameters.easing === null
  )
    return [];
  const matching = r.parameters.property
    ? own.filter((a) => channels(a).includes(r.parameters.property!))
    : own;
  const movement = matching.filter(
    (a) => !["fadeIn", "fadeOut", "trimPath", "maskReveal"].includes(a.effect),
  );
  return [...(movement.length ? movement : matching)]
    .sort(
      (a, b) =>
        b.startFrame - a.startFrame ||
        a.animationId.localeCompare(b.animationId),
    )
    .slice(0, 1);
}
export function isParameterOnlyEdit(r: IntentRequirement) {
  return (
    r.kind === "editAnimation" &&
    r.parameters.easing === null &&
    [
      r.parameters.durationSeconds,
      r.parameters.durationFactor,
      r.parameters.amplitude,
      r.parameters.intensity,
      r.parameters.amplitudeFactor,
      r.parameters.frequency,
      r.parameters.frequencyFactor,
      r.parameters.decay,
      r.parameters.seed,
    ].some((v) => v != null)
  );
}
export function requirementEasing(r: IntentRequirement): Easing | undefined {
  if (isParameterOnlyEdit(r)) return undefined;
  if (r.techniques.includes("spring") && r.techniques.includes("customCurve"))
    throw new Error("Conflicting easing techniques");
  if (r.techniques.includes("spring")) {
    if (
      r.parameters.easing &&
      !(
        typeof r.parameters.easing === "object" &&
        r.parameters.easing.type === "spring"
      )
    )
      throw new Error("Spring requires structured spring easing");
    return (
      r.parameters.easing ?? {
        type: "spring",
        parameters: { stiffness: 100, damping: 10, mass: 1 },
      }
    );
  }
  if (r.techniques.includes("customCurve")) {
    if (r.parameters.easing && !isCustomEasing(r.parameters.easing))
      throw new Error("customCurve requires cubicBezier or piecewise easing");
    return (
      r.parameters.easing ?? {
        type: "cubicBezier",
        parameters: { x1: 0.85, y1: 0, x2: 0.15, y2: 1 },
      }
    );
  }
  return r.parameters.easing ?? undefined;
}
export function compileRequirement(
  project: LoadedProject,
  state: MotionState,
  input: IntentPlan,
  task: IntentTask,
): Plan {
  const plan = expandInheritance(input),
    reqs = plan.requirements.filter((r) =>
      task.requirementIds.includes(r.requirementId),
    );
  const operations: Plan["operations"] = [],
    warnings: string[] = [];
  if (task.kind === "sceneTiming")
    operations.push({
      type: "retimeScenes",
      starts: reqs.map((r) => ({
        sceneId: r.sceneId!,
        startFrame: Math.round(r.timing.startSeconds! * state.settings.fps),
      })),
    });
  else {
    const r = reqs[0],
      block = state.blocks.find((b) => b.sceneId === r.sceneId);
    if (!block) throw new Error("Scene interval missing");
    const own = (a: { sceneId: string; targetId: string }) =>
      a.sceneId === r.sceneId && a.targetId === r.target.sourceNodeId;
    const anchorReq = plan.requirements.find(
      (x) => x.requirementId === r.timing.anchorRequirementId,
    );
    const anchor = anchorReq
      ? state.animations.find(
          (a) =>
            a.sceneId === anchorReq.sceneId &&
            a.targetId === anchorReq.target.sourceNodeId &&
            a.enabled &&
            a.effect !== "fadeIn" &&
            a.effect !== "fadeOut",
        )
      : undefined;
    if (r.timing.anchorRequirementId && !anchor)
      throw new Error("Anchor requirement has no persisted base action");
    const fps = state.settings.fps;
    let start =
      r.timing.startSeconds !== null
        ? Math.round(r.timing.startSeconds * fps)
        : r.timing.relation === "afterRequirement"
          ? anchor!.startFrame + anchor!.durationFrames
          : r.timing.relation === "withRequirement"
            ? anchor!.startFrame
            : block.startFrame;
    start += Math.round(r.timing.delaySeconds * fps);
    let duration = Math.max(
      1,
      Math.round(
        (r.parameters.durationSeconds ?? 0.7) *
          fps *
          (r.parameters.durationFactor ?? 1),
      ),
    );

    const hasInertia = r.techniques.includes("inertialOvershoot");
    if (
      r.techniques.includes("objectStateTransition") &&
      r.timing.startSeconds === null
    ) {
      const nextBlock =
        state.blocks.find((b) => b.sceneId === r.parameters.toSceneId) ??
        state.blocks[state.blocks.indexOf(block) + 1];
      if (!nextBlock) throw new Error("Transition requires next source state");
      start = nextBlock.startFrame - duration;
    }
    if (r.timing.relation === "sceneEnd")
      start = block.startFrame + block.durationFrames - duration;
    if (r.timing.relation === "beforeRequirement")
      start =
        anchor!.startFrame - duration + Math.round(r.timing.delaySeconds * fps);
    if (
      start < block.startFrame ||
      start >= block.startFrame + block.durationFrames
    )
      throw new Error("Requested action outside its scene");
    const remaining = block.startFrame + block.durationFrames - start;
    if (remaining < duration + (hasInertia ? 4 : 0)) {
      if (r.parameters.durationSeconds !== null)
        throw new Error("Explicit duration does not fit scene");
      duration = Math.max(1, Math.floor(remaining * (hasInertia ? 0.35 : 0.8)));
      warnings.push("Default entrance shortened to fit the scene");
    }
    if (r.techniques.includes("objectStateTransition")) {
      const object = buildRegistry(
        project.inspection.document,
        project.inspection.fingerprint,
      ).objects.find((o) => o.logicalObjectId === r.target.logicalObjectId);
      if (!object) throw new Error("LOGICAL_OBJECT_UNRESOLVED");
      const toSceneId =
        r.parameters.toSceneId ??
        state.blocks[state.blocks.indexOf(block) + 1]?.sceneId;
      if (!toSceneId) throw new Error("TARGET_STATE_MISSING");
      operations.push({
        type: "animateObjectStateTransition",
        transitionId:
          "intent_transition_" +
          stable([object.logicalObjectId, r.sceneId, toSceneId]),
        logicalObjectId: object.logicalObjectId,
        fromSceneId: r.parameters.fromSceneId ?? r.sceneId!,
        toSceneId,
        startFrame: start,
        durationFrames: duration,
        easing: r.parameters.easing ?? "easeInOutCubic",
        proceduralEffects: [],
        layerPolicy: { type: "switch", switchProgress: 1 },
      });
    } else if (task.kind === "editAnimation") {
      const targets = requirementAnimations(state, r);
      const expressions =
        state.expressions?.filter(
          (e) =>
            own(e) &&
            e.enabled &&
            r.techniques.includes(e.type as IntentTechnique) &&
            (!r.expressionIds || r.expressionIds.includes(e.expressionId)) &&
            (!r.parameters.property || e.property === r.parameters.property),
        ) ?? [];
      if (!targets.length && !expressions.length && !hasInertia)
        throw new Error(
          "UNSUPPORTED_COMPOUND_EDIT: No matching existing effect to edit",
        );
      for (const a of targets) {
        const next = structuredClone(a);
        if (requirementEasing(r)) next.easing = requirementEasing(r)!;
        if (
          (next.effect === "trimPath" || next.effect === "maskReveal") &&
          r.parameters.direction !== null
        )
          next.parameters.direction = r.parameters.direction;
        if (next.effect === "moveTo") {
          if (r.parameters.x !== null) next.parameters.toX = r.parameters.x;
          if (r.parameters.y !== null) next.parameters.toY = r.parameters.y;
        }
        if (next.effect === "scaleIn" || next.effect === "scaleOut") {
          if (r.parameters.scaleFrom !== null)
            next.parameters.from = r.parameters.scaleFrom;
          if (r.parameters.scaleTo !== null)
            next.parameters.to = r.parameters.scaleTo;
        }
        if (
          (next.effect === "slideUp" ||
            next.effect === "slideDown" ||
            next.effect === "slideLeft" ||
            next.effect === "slideRight") &&
          r.parameters.distance !== null
        )
          next.parameters.distance = r.parameters.distance;
        if (r.parameters.durationFactor !== null)
          next.durationFrames = Math.max(
            1,
            Math.round(next.durationFrames * r.parameters.durationFactor),
          );
        if (r.parameters.durationSeconds !== null)
          next.durationFrames = Math.max(
            1,
            Math.round(r.parameters.durationSeconds * fps),
          );
        if (
          next.effect === "keyframes" &&
          next.durationFrames !== a.durationFrames
        )
          next.parameters.points = next.parameters.points.map((p) => ({
            ...p,
            frame: Math.round(
              (p.frame * next.durationFrames) / a.durationFrames,
            ),
          }));
        operations.push({
          type: "updateAnimation",
          animationId: a.animationId,
          animation: next,
        });
        for (const e of state.expressions ?? []) {
          if (
            "sourceAnimationId" in e &&
            e.sourceAnimationId === a.animationId
          ) {
            const linked = structuredClone(e);
            linked.startFrame =
              linked.type === "inertialOvershoot" &&
              linked.parameters.mode === "ae" &&
              e.startFrame < a.startFrame + a.durationFrames
                ? next.startFrame + e.startFrame - a.startFrame
                : next.startFrame +
                  next.durationFrames +
                  e.startFrame -
                  a.startFrame -
                  a.durationFrames;
            if (
              linked.type === "inertialOvershoot" &&
              r.techniques.includes("inertialOvershoot") &&
              (next.easing === "aeEasyEase" ||
                (typeof next.easing === "object" &&
                  next.easing.type === "aeEasyEase"))
            )
              linked.parameters.mode = "ae";
            operations.push({ type: "setExpression", expression: linked });
          }
        }
      }
      for (const e of expressions) {
        if (r.expressionAction === "remove") {
          operations.push({
            type: "removeExpression",
            expressionId: e.expressionId,
          });
          continue;
        }
        const updated = [...operations]
          .reverse()
          .find(
            (op) =>
              op.type === "setExpression" &&
              op.expression.expressionId === e.expressionId,
          );
        const next = structuredClone(
          updated?.type === "setExpression" ? updated.expression : e,
        );
        if (r.parameters.property) next.property = r.parameters.property;
        if (next.type === "wiggle" && r.parameters.seed != null)
          next.parameters.seed = r.parameters.seed;
        if (!targets.length && r.parameters.durationSeconds !== null)
          next.durationFrames = Math.max(
            1,
            Math.round(r.parameters.durationSeconds * fps),
          );
        else if (!targets.length && r.parameters.durationFactor !== null)
          next.durationFrames = Math.max(
            1,
            Math.round(next.durationFrames * r.parameters.durationFactor),
          );
        if (r.parameters.amplitudeFactor !== null)
          next.parameters.amplitude *= r.parameters.amplitudeFactor;
        else if (
          next.type === "inertialOvershoot" &&
          r.parameters.intensity !== null &&
          r.parameters.intensity !== "normal" &&
          r.parameters.amplitude === null
        )
          next.parameters.amplitude *=
            inertiaIntensityDefaults[r.parameters.intensity].amplitude /
            inertiaIntensityDefaults.normal.amplitude;
        if (r.parameters.amplitude !== null)
          next.parameters.amplitude = r.parameters.amplitude;
        if (
          "frequency" in next.parameters &&
          r.parameters.frequencyFactor !== null
        )
          next.parameters.frequency *= r.parameters.frequencyFactor;
        if ("frequency" in next.parameters && r.parameters.frequency !== null)
          next.parameters.frequency = r.parameters.frequency;
        if ("decay" in next.parameters && r.parameters.decay !== null)
          next.parameters.decay = r.parameters.decay;
        operations.push({ type: "setExpression", expression: next });
      }
      if (
        hasInertia &&
        r.expressionAction !== "remove" &&
        !r.expressionIds &&
        (targets.length > 0 || !expressions.length)
      ) {
        const candidate = applyOperations(state, operations, project);
        operations.push(...compileInertiaAttachments(candidate, r, true));
      }
    } else {
      const requested: (IntentTechnique | "property")[] = r.techniques.filter(
        (t) => semanticBindings[t] === "animation",
      );
      const modifier = r.techniques.some(
        (t) => semanticBindings[t] === "easing",
      );
      if (modifier && !requested.length) {
        const previous = requirementAnimations(state, r)[0];
        if (previous) {
          const animation = {
            ...structuredClone(previous),
            easing: requirementEasing(r)!,
          };
          if (r.parameters.durationSeconds !== null)
            animation.durationFrames = Math.max(
              1,
              Math.round(r.parameters.durationSeconds * fps),
            );
          else if (r.parameters.durationFactor !== null)
            animation.durationFrames = Math.max(
              1,
              Math.round(
                animation.durationFrames * r.parameters.durationFactor,
              ),
            );
          operations.push({
            type: "updateAnimation",
            animationId: previous.animationId,
            animation,
          });
        } else requested.push("property");
      }
      for (const effect of requested) {
        const old = state.animations.find((a) => own(a) && a.effect === effect);
        const animationId =
          old?.animationId ??
          "intent_" + stable([r.sceneId, r.target.sourceNodeId, effect]);
        const common = {
          animationId,
          sceneId: r.sceneId!,
          targetId: r.target.sourceNodeId!,
          startFrame: start,
          durationFrames: duration,
          easing:
            requirementEasing(r) ??
            (effect === "trimPath"
              ? "linear"
              : hasInertia
                ? {
                    type: "cubicBezier",
                    parameters: { x1: 1 / 3, y1: 0, x2: 2 / 3, y2: 1 },
                  }
                : "easeOutCubic"),
          enabled: true,
        } as const;
        let a: Animation;
        if (effect === "property")
          a = {
            ...common,
            effect: "property",
            parameters: {
              property: r.parameters.property ?? "y",
              from: r.parameters.distance ?? 80,
              to: 0,
            },
          };
        else if (effect === "rotation")
          a = {
            ...common,
            effect: "rotation",
            parameters: { from: 0, to: r.parameters.distance ?? 15 },
          };
        else if (effect.startsWith("slide"))
          a = {
            ...common,
            effect: effect as "slideUp",
            parameters: { distance: r.parameters.distance ?? 80, mode: "in" },
          };
        else if (effect === "fadeIn" || effect === "fadeOut")
          a = {
            ...common,
            effect,
            parameters: {
              from: effect === "fadeIn" ? 0 : 1,
              to: effect === "fadeIn" ? 1 : 0,
            },
          };
        else if (effect === "maskReveal")
          a = {
            ...common,
            effect,
            parameters: {
              from: 0,
              to: 1,
              direction: r.parameters.direction ?? "forward",
            },
          };
        else if (effect === "trimPath")
          a = {
            ...common,
            effect,
            parameters: {
              from: 0,
              to: 1,
              direction: r.parameters.direction ?? "forward",
            },
          };
        else if (effect === "scaleIn" || effect === "scaleOut")
          a = {
            ...common,
            effect,
            parameters: {
              from: r.parameters.scaleFrom ?? (effect === "scaleIn" ? 0.8 : 1),
              to: r.parameters.scaleTo ?? (effect === "scaleIn" ? 1 : 0.8),
            },
          };
        else if (effect === "moveTo") {
          let x = r.parameters.x ?? 0,
            y = r.parameters.y ?? 0;
          if (r.parameters.moveToCenter) {
            const logical = buildRegistry(
              project.inspection.document,
              project.inspection.fingerprint,
            ).objects.find(
              (o) => o.logicalObjectId === r.target.logicalObjectId,
            );
            if (!logical) throw new Error("Position target state missing");
            const geometry = resolveState(
              project.inspection.document,
              logical,
              r.sceneId!,
            );
            const m = geometry.transform,
              scene = project.inspection.document.scenes.find(
                (s) => s.sceneId === r.sceneId,
              )!;
            x =
              scene.width / 2 -
              ((m[0][0] * geometry.width) / 2 +
                (m[0][1] * geometry.height) / 2 +
                m[0][2]);
            y =
              scene.height / 2 -
              ((m[1][0] * geometry.width) / 2 +
                (m[1][1] * geometry.height) / 2 +
                m[1][2]);
          }
          a = {
            ...common,
            effect,
            parameters: { fromX: 0, fromY: 0, toX: x, toY: y },
          };
        } else
          throw new Error(
            "Deterministic compiler does not support this technique: " + effect,
          );
        const writes = channels(a);
        for (const previous of state.animations.filter(
          (previous) =>
            own(previous) &&
            (channels(previous).some((c) => writes.includes(c)) ||
              (effect === "trimPath" &&
                /reveal|ribbon|trim/i.test(previous.animationId) &&
                channels(previous).some((c) => c.startsWith("scale")))),
        ))
          if (
            !operations.some(
              (op) =>
                op.type === "removeAnimation" &&
                op.animationId === previous.animationId,
            )
          ) {
            for (const dep of state.timingDependencies ?? [])
              if (
                dep.animationId === previous.animationId &&
                previous.animationId !== a.animationId
              )
                operations.push({
                  type: "removeTimingDependency",
                  dependencyId: dep.dependencyId,
                });
            operations.push({
              type: "removeAnimation",
              animationId: previous.animationId,
            });
          }
        operations.push({ type: "addAnimation", animation: a });
        if (anchor && r.timing.relation.endsWith("Requirement"))
          operations.push({
            type: "setTimingDependency",
            dependency: {
              dependencyId:
                "dependency_" + stable([a.animationId, anchor.animationId]),
              animationId: a.animationId,
              anchorAnimationId: anchor.animationId,
              relation:
                r.timing.relation === "afterRequirement"
                  ? "after"
                  : r.timing.relation === "beforeRequirement"
                    ? "before"
                    : "with",
              offsetFrames: Math.round(r.timing.delaySeconds * fps),
            },
          });
      }
      if (r.techniques.includes("wiggle")) {
        const old = state.expressions?.find(
          (e) =>
            own(e) &&
            e.type === "wiggle" &&
            (!r.parameters.property || e.property === r.parameters.property),
        );
        const frames = Math.min(
          duration,
          block.startFrame + block.durationFrames - start,
          state.settings.durationFrames - start - 1,
        );
        if (frames < 1)
          throw new Error("Wiggle requires a finite visible interval");
        operations.push({
          type: "setExpression",
          expression: {
            expressionId:
              old?.expressionId ??
              "intent_wiggle_" +
                stable([
                  r.sceneId,
                  r.target.sourceNodeId,
                  r.parameters.property ?? "y",
                ]),
            sceneId: r.sceneId!,
            targetId: r.target.sourceNodeId!,
            type: "wiggle",
            property: r.parameters.property ?? "y",
            startFrame: start,
            durationFrames: frames,
            enabled: true,
            parameters: {
              amplitude: r.parameters.amplitude ?? 10,
              frequency: r.parameters.frequency ?? 2,
              seed:
                r.parameters.seed ??
                parseInt(
                  stable([r.sceneId, r.target.sourceNodeId]).slice(0, 7),
                  16,
                ),
            },
          },
        });
      }
      if (hasInertia) {
        const candidate = applyOperations(state, operations, project);
        operations.push(...compileInertiaAttachments(candidate, r));
      }
    }
  }
  return {
    status: "ready",
    summary: "Исполнено требование: " + task.userIntent,
    assumptions: [],
    warnings,
    operations,
  };
}
/** Shared creation path for standalone and compound edits, evaluated after base edits. */
function compileInertiaAttachments(
  state: MotionState,
  r: IntentRequirement,
  missingOnly = false,
): Plan["operations"] {
  const base = resolveBaseMotion(state, r.sceneId!, r.target.sourceNodeId!);
  if (base.status !== "RESOLVED") throw new Error(base.status);
  const block = state.blocks.find((b) => b.sceneId === r.sceneId)!;
  const operations: Plan["operations"] = [];
  for (const track of base.tracks) {
    const settle = Math.min(
      Math.round(1.2 * state.settings.fps),
      block.startFrame + block.durationFrames - track.endFrame - 1,
      state.settings.durationFrames - track.endFrame - 1,
    );
    if (settle < 4)
      throw new Error(
        "UNSUPPORTED_COMPOUND_EDIT: Insufficient settling interval after Position",
      );
    for (const property of track.properties) {
      if (r.parameters.property && property !== r.parameters.property) continue;
      const a = track.animation;
      if (
        a.effect === "moveTo" &&
        (property === "x"
          ? a.parameters.toX === a.parameters.fromX
          : a.parameters.toY === a.parameters.fromY)
      )
        continue;
      const existing = state.expressions?.find(
        (e) =>
          e.sceneId === r.sceneId &&
          e.targetId === r.target.sourceNodeId &&
          e.type === "inertialOvershoot" &&
          e.property === property,
      );
      if (missingOnly && existing) continue;
      const defaults =
        inertiaIntensityDefaults[r.parameters.intensity ?? "normal"];
      operations.push({
        type: "setExpression",
        expression: {
          expressionId:
            existing?.expressionId ??
            "intent_inertia_" +
              stable([r.sceneId, r.target.sourceNodeId, property]),
          sceneId: r.sceneId!,
          targetId: r.target.sourceNodeId!,
          property,
          type: "inertialOvershoot",
          sourceAnimationId: a.animationId,
          startFrame: track.endFrame,
          durationFrames: settle,
          enabled: true,
          parameters: {
            mode: "ae",
            amplitude: r.parameters.amplitude ?? defaults.amplitude,
            frequency: r.parameters.frequency ?? defaults.frequency,
            decay: r.parameters.decay ?? defaults.decay,
            velocityLookbackFrames: Math.min(a.durationFrames, 30),
          },
        },
      });
    }
  }
  return operations;
}
export function validateRequirement(state: MotionState, r: IntentRequirement) {
  if (r.kind === "unsupported" || r.unresolvedReason)
    return [
      {
        name: "targetResolved",
        status: "FAILED",
        reason: r.unresolvedReason ?? "unsupported",
      },
    ];
  if (r.kind === "sceneTiming")
    return [
      {
        name: "sceneTiming",
        status: state.blocks.some(
          (b) =>
            b.sceneId === r.sceneId &&
            b.startFrame ===
              Math.round(r.timing.startSeconds! * state.settings.fps),
        )
          ? "PASSED"
          : "FAILED",
      },
    ];
  const checks = r.techniques.map((technique) => {
    const kind = semanticBindings[technique];
    const found =
      kind === "transition"
        ? state.objectTransitions?.some(
            (t) =>
              t.logicalObjectId === r.target.logicalObjectId &&
              t.fromSceneId === r.sceneId &&
              (!r.parameters.toSceneId ||
                t.toSceneId === r.parameters.toSceneId),
          )
        : kind === "expression"
          ? state.expressions?.some(
              (e) =>
                e.enabled &&
                e.type === technique &&
                e.sceneId === r.sceneId &&
                e.targetId === r.target.sourceNodeId &&
                (technique !== "inertialOvershoot" ||
                  r.kind === "editAnimation" ||
                  (e.type === "inertialOvershoot" &&
                    e.parameters.mode === "ae")) &&
                (!r.parameters.property ||
                  e.property === r.parameters.property),
            )
          : kind === "easing"
            ? requirementAnimations(state, r).some((a) =>
                technique === "spring"
                  ? typeof a.easing === "object" && a.easing.type === "spring"
                  : isCustomEasing(a.easing) || isParameterOnlyEdit(r),
              ) ||
              (technique === "spring" &&
                r.kind === "editAnimation" &&
                state.expressions?.some(
                  (e) =>
                    e.type === "spring" &&
                    e.enabled &&
                    e.sceneId === r.sceneId &&
                    e.targetId === r.target.sourceNodeId,
                ))
            : state.animations.some(
                (a) =>
                  a.enabled &&
                  a.effect === technique &&
                  a.sceneId === r.sceneId &&
                  a.targetId === r.target.sourceNodeId,
              );
    return {
      name: "requiredTechnique",
      technique,
      status: found ? "PASSED" : "FAILED",
    };
  });
  if (
    r.techniques.includes("inertialOvershoot") &&
    (r.parameters.easing === "aeEasyEase" ||
      (typeof r.parameters.easing === "object" &&
        r.parameters.easing?.type === "aeEasyEase"))
  )
    checks.push({
      name: "aeVelocityMode",
      technique: "inertialOvershoot",
      status: state.expressions?.some(
        (e) =>
          e.enabled &&
          e.type === "inertialOvershoot" &&
          e.sceneId === r.sceneId &&
          e.targetId === r.target.sourceNodeId &&
          e.parameters.mode === "ae",
      )
        ? "PASSED"
        : "FAILED",
    });
  return checks;
}
