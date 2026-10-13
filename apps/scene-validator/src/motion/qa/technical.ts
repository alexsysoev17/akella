import { planMotionTasks } from "../tasks.js";
import type { LoadedProject } from "../../types.js";
import type { MotionState } from "../schema.js";
export interface Requirement {
  taskId?: string;
  technique: string;
  implementationId: string;
  targets: { sceneId: string; targetId: string }[];
}
export class MotionFailure extends Error {
  constructor(public report: unknown) {
    super(JSON.stringify(report));
  }
}
export function intentRequirements(
  project: LoadedProject,
  state: MotionState,
  request: string,
  context: unknown,
): Requirement[] {
  return planMotionTasks(project, state, request, context).map((task) => ({
    taskId: task.taskId,
    technique: task.techniqueId === "trimPath" ? "trimPaths" : task.techniqueId,
    implementationId: task.techniqueId,
    targets: [
      {
        sceneId: task.targetReference.sceneId,
        targetId: task.targetReference.targetId,
      },
    ],
  }));
}

export function validateTechnique(
  next: MotionState,
  requirements: Requirement[],
) {
  const checks = requirements.flatMap((r) =>
    r.targets.map((target) => {
      const found =
        r.implementationId === "trimPath"
          ? next.animations.some(
              (a) =>
                a.enabled &&
                a.effect === "trimPath" &&
                a.targetId === target.targetId &&
                a.sceneId === target.sceneId,
            )
          : next.expressions?.some(
              (e) =>
                e.enabled &&
                e.type === "inertialOvershoot" &&
                e.targetId === target.targetId &&
                e.sceneId === target.sceneId,
            );
      return {
        name: "techniqueMatch",
        taskId: r.taskId,
        status: found ? "PASSED" : "FAILED",
        code: found ? undefined : "TECHNIQUE_MISMATCH",
        expected: r.implementationId,
        target,
      };
    }),
  );
  if (checks.some((c) => c.status === "FAILED"))
    throw new MotionFailure({ status: "FAILED", phase: "technical", checks });
  return checks;
}
