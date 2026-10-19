import { failureCategory, infrastructureFailure } from "../qa/failure.js";
import { taskRepairContext } from "./repair-context.js";
import { qaAdmission } from "../qa/policy.js";
import { resolveTextSettings } from "../../motion-library/techniques/text.js";
import { isDeepStrictEqual } from "node:util";
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
import { applyOperations, channels } from "../operations.js";
import { resolveTimingDependencies } from "./retime.js";
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
  const exprAllowed = (e: NonNullable<MotionState["expressions"]>[number]) =>
    own(e) &&
    (!r.expressionIds || r.expressionIds.includes(e.expressionId)) &&
    (r.techniques.includes(e.type as (typeof r.techniques)[number]) ||
      ("sourceAnimationId" in e && allowedIds.has(e.sourceAnimationId)));
  baseline.expressions = [
    ...(before.expressions ?? []).filter((e) => !exprAllowed(e)),
    ...(next.expressions ?? []).filter(exprAllowed),
  ];
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
      t.fromSceneId === r.sceneId &&
      (!r.parameters.toSceneId || t.toSceneId === r.parameters.toSceneId);
    baseline.objectTransitions = [
      ...(before.objectTransitions ?? []).filter((t) => !allowedTransition(t)),
      ...(next.objectTransitions ?? []).filter(allowedTransition),
    ];
  }
  resolveTimingDependencies(baseline);
  const canonical = (s: MotionState) => ({
    ...s,
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
  if (!isDeepStrictEqual(canonical(baseline), canonical(next)))
    throw new Error(
      "TASK_SCOPE_VIOLATION: operations modify targets/techniques outside this requirement; fade and timing allowed only where present in contract",
    );
}
export function requirementChecks(
  state: MotionState,
  r: IntentRequirement,
  plan: IntentPlan,
  previous?: MotionState,
) {
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
  const checks = validateRequirement(presenceState, r).map((c) => ({
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
        r.timing.reference ||
        r.timing.anchorRequirementId ||
        r.timing.startSeconds !== null ||
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
            r.effectOperation?.action === "updateTiming" ||
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
          a.parameters.mode === "in" &&
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
    block = state.blocks.find((b) => b.sceneId === r.sceneId);
  if (
    primary &&
    block &&
    (r.kind !== "editAnimation" ||
      r.timing.reference ||
      r.timing.anchorRequirementId ||
      r.timing.startSeconds !== null ||
      r.effectOperation?.action === "updateTiming")
  ) {
    const anchorReq = plan.requirements.find(
      (x) => x.requirementId === r.timing.anchorRequirementId,
    );
    const anchor = r.timing.reference
      ? state.animations.find(
          (a) => a.animationId === r.timing.reference!.resolvedAnimationId,
        )
      : requirementAnchor(state, anchorReq);
    const delay =
      r.timing.offsetFrames ??
      Math.round(r.timing.delaySeconds * state.settings.fps);
    const expected = r.timing.reference
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
        status: related.every((a) => a.startFrame === expected)
          ? "PASSED"
          : "FAILED",
      });
    if (r.timing.anchorRequirementId || r.timing.reference)
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
      (e.type !== "wiggle" ||
        r.parameters.seed == null ||
        e.parameters.seed === r.parameters.seed);
    checks.push({
      name: "expressionParameters",
      requirementId: r.requirementId,
      status: ok ? "PASSED" : "FAILED",
    });
    if (e.type === "wiggle" && r.kind !== "editAnimation") {
      const expected =
        r.timing.startSeconds !== null
          ? Math.round(r.timing.startSeconds * state.settings.fps)
          : block?.startFrame;
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
        ? state.animations.find((a) => a.animationId === e.sourceAnimationId)
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
  },
) {
  const preflightStarted = performance.now();
  const plan = expandInheritance(input),
    tasks = compileTasks(project, plan),
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
            generated = compileRequirement(project, current, plan, task);
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
        try {
          next = applyOperations(current, generated.operations, project);
        } catch (error) {
          throw new Error(
            (attempt === 1
              ? "OPERATION_VALIDATION_ERROR: "
              : "MODEL_OPERATION_VALIDATION_ERROR: ") + String(error),
          );
        }
        assertIntentScope(project, current, next, plan, task);
        const checks = plan.requirements
          .filter((r) => task.requirementIds.includes(r.requirementId))
          .flatMap((r) => requirementChecks(next, r, plan, current));
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
    selectedObjectCount: new Set(
      plan.requirements
        .filter((r) => r.target.sourceNodeId)
        .map((r) => r.sceneId + "/" + r.target.sourceNodeId),
    ).size,
    selectedAnimationCount: new Set(
      plan.requirements.flatMap((r) => r.animationIds ?? []),
    ).size,
    selectedExpressionCount: new Set(
      plan.requirements.flatMap((r) => r.expressionIds ?? []),
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

/** Full deterministic candidate preflight; no persistence, renderer or provider call. */
export function preflightIntentPlan(
  project: LoadedProject,
  state: MotionState,
  input: IntentPlan,
) {
  const preflightStarted = performance.now();
  const plan = expandInheritance(input),
    tasks = compileTasks(project, plan),
    done = new Set<string>();
  let candidate = structuredClone(state);
  const reports: unknown[] = [];
  while (done.size < tasks.length) {
    const task = tasks.find(
      (t) => !done.has(t.taskId) && t.dependencies.every((id) => done.has(id)),
    );
    if (!task)
      throw Object.assign(
        new Error("INTENT_PREFLIGHT_FAILED: dependency cycle"),
        { report: { status: "FAILED", reports } },
      );
    try {
      if (task.status === "BLOCKED")
        throw new Error(task.error ?? "UNSUPPORTED_REQUIREMENT");
      const compilationStarted = performance.now();
      const compiled = compileRequirement(project, candidate, plan, task),
        next = applyOperations(candidate, compiled.operations, project);
      assertIntentScope(project, candidate, next, plan, task);
      const checks = plan.requirements
        .filter((r) => task.requirementIds.includes(r.requirementId))
        .flatMap((r) => requirementChecks(next, r, plan, candidate));
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
            taskId: task.taskId,
            reports,
            failure: String(error),
            checks: (error as { checks?: unknown }).checks,
          },
        },
      );
    }
  }
  return {
    status: "PASSED",
    durationMs: performance.now() - preflightStarted,
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
