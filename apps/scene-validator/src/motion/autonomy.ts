import { qaAdmission } from "./qa/policy.js";
import {
  assertTaskScope,
  validateTaskExecution,
  type MotionTask,
} from "./tasks.js";
import {
  intentRequirements,
  validateTechnique,
  MotionFailure,
} from "./qa/technical.js";
import { resolveObjectReference } from "./object-resolution.js";
import { buildRegistry } from "./registry.js";
import type { LoadedProject } from "../types.js";
import type { MotionState, Plan } from "./schema.js";
import { parsePlan } from "./schema.js";
import { applyOperations } from "./operations.js";
import { objectsIn } from "./context.js";
export const MAX_AGENT_ATTEMPTS = 3;
export function resolveTarget(
  project: LoadedProject,
  state: MotionState,
  request: {
    request: string;
    mentions?: { sourceNodeId: string; sceneId: string }[];
    selectedObjectId?: string;
    selectedSceneId?: string;
    activeSceneId?: string;
  },
  previous: { selectedObjectId?: string; selectedSceneId?: string }[],
) {
  const all = project.inspection.document.scenes.flatMap(objectsIn);
  const assumptions: string[] = [];
  const matching = (id?: string, scene?: string) =>
    all.find((o) => o.targetId === id && (!scene || o.sceneId === scene));
  const mention = request.mentions?.[0];
  let target =
    matching(mention?.sourceNodeId, mention?.sceneId) ??
    matching(request.selectedObjectId, request.selectedSceneId);
  if (!target) {
    const resolved = resolveObjectReference(project, state, {
      referenceText: request.request,
      activeSceneId: request.activeSceneId,
      preferExisting: true,
    });
    if (resolved.status === "AMBIGUOUS_TARGET")
      throw new Error(
        "AMBIGUOUS_TARGET: " + JSON.stringify(resolved.candidates),
      );
    if (resolved.target) {
      target = matching(resolved.target.sourceNodeId, resolved.target.sceneId);
      if (resolved.rejectedCandidates.length)
        assumptions.push(
          `«${resolved.target.canonicalName}»: выбран ${resolved.target.sourceNodeId} в ${resolved.target.sceneId}; ограничения: ${[...new Set(resolved.rejectedCandidates.map((c) => c.reason))].join(", ")}.`,
        );
    }
  }
  const registry = buildRegistry(
    project.inspection.document,
    project.inspection.fingerprint,
  );
  const explicit = registry.objects
    .filter((o) => o.name.length > 0 && request.request.includes(o.name))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (!target && explicit) {
    const ref =
      explicit.states.find((s) => s.sceneId === request.activeSceneId) ??
      explicit.states[0];
    if (ref) {
      target = matching(ref.sourceNodeId, ref.sceneId);
      if (explicit.sourceInstances.length > 1)
        assumptions.push(
          `«${explicit.name}»: выбран исходный экземпляр ${ref.sourceNodeId}; логические состояния доступны отдельно.`,
        );
    }
  }
  if (!target && !explicit && state.objectTransitions?.length) {
    const last = state.objectTransitions.at(-1)!;
    const o = registry.objects.find(
      (o) => o.logicalObjectId === last.logicalObjectId,
    );
    const ref = o?.states.find((s) => s.sceneId === last.fromSceneId);
    if (ref) target = matching(ref.sourceNodeId, ref.sceneId);
  }
  const query = request.request.toLocaleLowerCase();
  const named = all.filter(
    (o) =>
      query.includes(o.targetId.toLowerCase()) ||
      [o.name, o.text ?? ""].some(
        (name) =>
          name.trim().length >= 3 && query.includes(name.trim().toLowerCase()),
      ),
  );
  if (!target && named.length) {
    target = named.find((o) => o.sceneId === request.activeSceneId) ?? named[0];
    if (named.length > 1)
      assumptions.push(
        `Несколько совпадений имени: выбран ${target.name} (${target.targetId}) в сцене ${target.sceneId}.`,
      );
  }
  const textIntent = /текст|надпис|text|headline/i.test(query);
  const visual = all.filter((o) => !o.mask && o.visible);
  const typed = visual.filter((o) => !textIntent || o.type === "TEXT");
  const pool = typed.length ? typed : visual;
  if (textIntent && !typed.length)
    assumptions.push(
      "Текстовых слоёв нет: выбран подходящий визуальный контейнер как приближение.",
    );
  const rank = (items: typeof all) =>
    [...items].sort(
      (a, b) =>
        (a.type === "FRAME" ? 1 : 0) - (b.type === "FRAME" ? 1 : 0) ||
        Number(b.type === "TEXT") - Number(a.type === "TEXT") ||
        b.width * b.height - a.width * a.height ||
        a.targetId.localeCompare(b.targetId),
    );
  if (!target && request.activeSceneId) {
    target = rank(pool.filter((o) => o.sceneId === request.activeSceneId))[0];
    if (target)
      assumptions.push(
        `Объект выбран по активной сцене: ${target.name} (${target.targetId}).`,
      );
  }
  if (!target) {
    for (const recent of [...previous].reverse()) {
      target = matching(recent.selectedObjectId, recent.selectedSceneId);
      if (target) break;
    }
  }
  if (!target) {
    const last = state.animations.at(-1);
    target = matching(last?.targetId, last?.sceneId);
  }
  if (!target) {
    target = rank(pool)[0] ?? rank(all.filter((o) => !o.mask))[0];
    if (target)
      assumptions.push(
        `По контексту выбран наиболее вероятный объект: ${target.name} (${target.targetId}).`,
      );
  }
  if (target?.mask) {
    const parent = matching(target.parentId, target.sceneId);
    if (parent && !parent.mask) {
      assumptions.push(
        `Вместо маски ${target.targetId} анимируется визуальный контейнер ${parent.targetId}.`,
      );
      target = parent;
    }
  }
  if (!target)
    throw new Error(
      "Нет доступного визуального объекта для анимации. Изменения не применены.",
    );
  return { target, assumptions };
}
export async function runAutonomous(
  project: LoadedProject,
  state: MotionState,
  context: unknown,
  request: string,
  call: (
    context: unknown,
    request: string,
    attempt: number,
  ) => Promise<unknown>,
  log: (entry: unknown, attempt: number) => Promise<void> = async () => {},
  verify?: (state: MotionState, attempt: number) => Promise<unknown>,
  task?: MotionTask,
) {
  const requirements = task
    ? [
        {
          taskId: task.taskId,
          technique: task.techniqueId,
          implementationId: task.techniqueId,
          targets: [task.targetReference],
        },
      ]
    : intentRequirements(project, state, request, context);
  let feedback: unknown = null,
    lastError = "";
  for (let attempt = 1; attempt <= MAX_AGENT_ATTEMPTS; attempt++) {
    let response: unknown;
    try {
      response = await call(
        {
          ...(context as Record<string, unknown>),
          runtimeFeedback: feedback,
          autonomousPolicy: {
            noQuestions: true,
            maxAttempts: MAX_AGENT_ATTEMPTS,
            attempt,
          },
        },
        request,
        attempt,
      );
      const plan = parsePlan(response);
      if (plan.status === "unsupported")
        throw new Error(
          `Техническое ограничение: ${plan.summary}. ${plan.warnings.join(" ")}`,
        );
      if (!plan.operations.length)
        throw new Error(
          "Нет Motion Operations. Выберите разумную трактовку и выполните движение; не сообщайте об успехе без изменения.",
        );
      if (
        [plan.summary, ...plan.assumptions, ...plan.warnings].some((text) =>
          text.includes("?"),
        )
      )
        throw new Error(
          "Ответ содержит вопрос. Выберите параметры автономно и верните исполнимый результат без вопросов.",
        );
      const next = applyOperations(state, plan.operations, project);
      if (JSON.stringify(next) === JSON.stringify(state))
        throw new Error(
          "Операции не изменили анимацию. Верните фактическое изменение по запросу.",
        );
      if (task) {
        assertTaskScope(state, next, task);
        validateTaskExecution(next, task);
      }
      const technical = validateTechnique(next, requirements);
      if (verify)
        await log(
          { status: "checking", plan, requirements, technical },
          attempt,
        );
      const qa = verify
        ? await verify(next, attempt)
        : { status: "NOT_TESTED" };
      if (verify && !qaAdmission(qa).accepted) throw new MotionFailure(qa);
      await log(
        { status: "validated", plan, requirements, technical, qa },
        attempt,
      );
      return { plan, next, attempts: attempt, qa, requirements };
    } catch (error) {
      lastError = String(error);
      feedback = {
        error: lastError,
        task: task
          ? {
              taskId: task.taskId,
              targetReference: task.targetReference,
              techniqueId: task.techniqueId,
              parameters: task.parameters,
            }
          : undefined,
        expectedTechnique: task?.techniqueId,
        repairScope: task?.targetReference,
        ...(error instanceof MotionFailure ? { qaReport: error.report } : {}),
        ...(response ? { previousResponse: response } : {}),
        instruction:
          "Исправьте результат самостоятельно. Не задавайте вопросов. Используйте capability schemas. Не подменяйте явно требуемую технику. Исправьте QA failures, сохранив остальные параметры. Новая попытка применяется к исходному неизменённому state, поэтому верните полный исправленный batch.",
      };
      await log({ status: "repair", ...(feedback as object) }, attempt);
      // Auth/network/tool-boundary failures are not animation validation errors.
      if (
        /ENOENT|авторизац|authentication|login|401|403|инструменты|контекст превышает|timeout|aborted/i.test(
          lastError,
        )
      )
        throw error;
    }
  }
  throw new Error(
    `Агент не смог применить анимацию после ${MAX_AGENT_ATTEMPTS} попыток. Причина: ${lastError}. Изменения не применены.`,
  );
}
