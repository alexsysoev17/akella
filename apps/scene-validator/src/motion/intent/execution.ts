import { isDeepStrictEqual } from "node:util";
import type { LoadedProject } from "../../types.js";
import type { MotionState, Plan } from "../schema.js";
import type { IntentPlan, IntentRequirement } from "./schema.js";
import {
  requirementAnimations,
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
    (r.techniques.includes(e.type as (typeof r.techniques)[number]) ||
      ("sourceAnimationId" in e && allowedIds.has(e.sourceAnimationId)));
  baseline.expressions = [
    ...(before.expressions ?? []).filter((e) => !exprAllowed(e)),
    ...(next.expressions ?? []).filter(exprAllowed),
  ];
  baseline.timingDependencies = [
    ...(before.timingDependencies ?? []).filter(
      (d) => !allowedIds.has(d.animationId),
    ),
    ...(next.timingDependencies ?? []).filter((d) =>
      allowedIds.has(d.animationId),
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
  const checks = validateRequirement(state, r).map((c) => ({
    ...c,
    requirementId: r.requirementId,
  }));
  if (
    r.kind === "sceneTiming" ||
    r.kind === "unsupported" ||
    r.unresolvedReason
  )
    return checks;
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
      status: changed ? "PASSED" : "FAILED",
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
          now.startFrame === old.startFrame &&
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
  if (primary && block && r.kind !== "editAnimation") {
    const anchorReq = plan.requirements.find(
      (x) => x.requirementId === r.timing.anchorRequirementId,
    );
    const anchor = anchorReq
      ? state.animations.find(
          (a) =>
            a.enabled &&
            a.sceneId === anchorReq.sceneId &&
            a.targetId === anchorReq.target.sourceNodeId &&
            !a.effect.startsWith("fade"),
        )
      : undefined;
    const delay = Math.round(r.timing.delaySeconds * state.settings.fps);
    const expected =
      r.timing.startSeconds !== null
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
    if (r.timing.anchorRequirementId)
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
        generated =
          attempt === 1
            ? compileRequirement(project, current, plan, task)
            : parsePlan(
                await hooks.repair(
                  {
                    motion: current,
                    intentRequirement: plan.requirements.filter((r) =>
                      task.requirementIds.includes(r.requirementId),
                    ),
                    repairFeedback: feedback,
                  },
                  task.userIntent,
                  task,
                  attempt,
                ),
              );
        if (generated.status !== "ready" || !generated.operations.length)
          throw new Error("Requirement produced no executable operations");
        const next = applyOperations(current, generated.operations, project);
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
        if (checks.some((c) => c.status === "FAILED"))
          throw new Error(
            "INTENT_REQUIREMENT_MISMATCH: " +
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
        if (!["PASSED", "WARNING"].includes(qa.status))
          throw new Error("MOTION_QA_FAILED");
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
        const failureReason = String(error),
          signature = JSON.stringify({
            failureReason,
            failedChecks,
            operations: generated?.operations,
          });
        feedback = {
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
        };
        task.repairHistory.push({ attempt, feedback });
        await hooks.trace(tasks, { status: "repair", feedback });
        if (
          signature === previousSignature ||
          attempt === (hooks.maxAttempts ?? 3) ||
          /BUDGET|CANCELLED|authentication|timeout|aborted|401|403|login|Исходный дизайн|Анимация уже изменилась/i.test(
            failureReason,
          )
        ) {
          task.status = "FAILED";
          task.error = failureReason;
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
  const reconciliation = {
    requested: requirements.length,
    completed,
    qaPassed: requirements.filter(
      (r) =>
        r.status === "PASSED" &&
        (r.qaResult as { status: string })?.status === "PASSED",
    ).length,
    taskCount: tasks.length,
    operationCount: plans.reduce((n, p) => n + p.operations.length, 0),
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
    plan: {
      status: completed ? "ready" : "unsupported",
      summary: `Выполнено ${completed} из ${requirements.length} требований.`,
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
