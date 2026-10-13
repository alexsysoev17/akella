import type { LoadedProject } from "../types.js";
import type { MotionState, Plan } from "./schema.js";
import { planMotionTasks, type MotionTask } from "./tasks.js";
import { runAutonomous } from "./autonomy.js";
import { buildContext } from "./context.js";

export async function runMotionTasks(
  project: LoadedProject,
  initial: MotionState,
  context: unknown,
  request: string,
  hooks: {
    call: (
      task: MotionTask,
      context: unknown,
      request: string,
      attempt: number,
    ) => Promise<unknown>;
    verify: (
      task: MotionTask,
      next: MotionState,
      before: MotionState,
      attempt: number,
    ) => Promise<unknown>;
    commit: (
      task: MotionTask,
      plan: Plan,
      before: MotionState,
      after: MotionState,
    ) => Promise<void>;
    trace: (tasks: MotionTask[], entry?: unknown) => Promise<void>;
  },
) {
  const tasks = planMotionTasks(project, initial, request, context);
  let current = initial;
  const plans: Plan[] = [];
  await hooks.trace(tasks);
  for (const task of tasks) {
    if (task.status === "BLOCKED") continue;
    if (
      task.dependencies.some(
        (id) => tasks.find((t) => t.taskId === id)?.status !== "PASSED",
      )
    ) {
      task.status = "BLOCKED";
      task.error = "DEPENDENCY_FAILED: зависимая задача не выполнена";
      await hooks.trace(tasks);
      continue;
    }
    task.status = "RUNNING";
    await hooks.trace(tasks);
    const before = current;
    try {
      const taskContext = {
        ...(context as Record<string, unknown>),
        ...buildContext(
          project,
          current,
          task.userIntent,
          task.targetReference.targetId,
          task.targetReference.sceneId,
        ),
        motionTask: task,
        runtimeTarget: task.targetReference,
        mentions: [],
        completedTasks: tasks
          .filter((t) => t.status === "PASSED")
          .map((t) => ({
            taskId: t.taskId,
            target: t.targetReference,
            technique: t.techniqueId,
          })),
      };
      const result = await runAutonomous(
        project,
        current,
        taskContext,
        `Выполни только задачу ${task.taskId}: ${task.targetReference.name} → ${task.techniqueId}. Локальное намерение: ${task.userIntent}. Не изменяй другие эффекты и объекты, блоки или настройки. Существующее движение сохраняй; при отсутствии Position создай основное движение внутри блока объекта перед инерцией.`,
        (ctx, text, attempt) => hooks.call(task, ctx, text, attempt),
        async (entry, attempt) => {
          const record = entry as {
            plan?: Plan;
            technical?: unknown;
            qa?: unknown;
            qaReport?: unknown;
            previousResponse?: unknown;
          };
          if (record.plan) task.generatedOperations = record.plan.operations;
          if (record.technical)
            task.validationResult = {
              taskId: task.taskId,
              checks: record.technical,
              status: "PASSED",
            };
          if (record.qa ?? record.qaReport)
            task.qaResult = {
              taskId: task.taskId,
              ...((record.qa ?? record.qaReport) as object),
            };
          task.repairHistory.push({ attempt, entry });
          await hooks.trace(tasks, entry);
        },
        (next, attempt) => hooks.verify(task, next, before, attempt),
        task,
      );
      task.generatedOperations = result.plan.operations;
      task.validationResult = {
        status: "PASSED",
        taskId: task.taskId,
        requirements: result.requirements,
      };
      task.qaResult = { ...(result.qa as object), taskId: task.taskId };
      if (
        !["PASSED", "WARNING"].includes(
          (result.qa as { status: string }).status,
        )
      )
        throw new Error("QA_NOT_COMPLETED");
      await hooks.commit(task, result.plan, before, result.next);
      current = result.next;
      task.status = "PASSED";
      plans.push(result.plan);
    } catch (error) {
      task.status = "FAILED";
      task.error = String(error);
      task.validationResult ??= {
        status: "FAILED",
        taskId: task.taskId,
        reason: task.error,
      };
    }
    await hooks.trace(tasks);
  }
  const completed = tasks.filter((t) => t.status === "PASSED").length;
  const reconciliation = {
    requested: tasks.length,
    completed,
    qaPassed: tasks.filter(
      (t) =>
        t.status === "PASSED" &&
        (t.qaResult as { status: string })?.status === "PASSED",
    ).length,
    status:
      completed === tasks.length && completed > 0
        ? "SUCCESS"
        : completed
          ? "PARTIAL_SUCCESS"
          : "FAILED",
  };
  await hooks.trace(tasks, { reconciliation });
  const plan: Plan = {
    status: completed ? "ready" : "unsupported",
    summary: `Выполнено ${completed} из ${tasks.length} задач.`,
    assumptions: plans.flatMap((p) => p.assumptions).slice(0, 60),
    warnings: [
      ...plans.flatMap((p) => p.warnings),
      ...tasks
        .filter((t) => t.error)
        .map((t) => `${t.targetReference.name}: ${t.error}`),
    ]
      .map((s) => s.slice(0, 2000))
      .slice(0, 50),
    operations: plans.flatMap((p) => p.operations),
  };
  return { tasks, reconciliation, plan, next: current };
}
