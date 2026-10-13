import { evaluateAnimation } from "./engine.js";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import type { LoadedProject } from "../types.js";
import type { MotionState, Plan } from "./schema.js";
import { objectsIn } from "./context.js";
import { buildRegistry } from "./registry.js";

export interface MotionTask {
  taskId: string;
  userIntent: string;
  targetReference: {
    logicalObjectId?: string;
    sceneId: string;
    targetId: string;
    sourceNodeId: string;
    name: string;
  };
  techniqueId: "trimPath" | "inertialOvershoot";
  parameters: Record<string, unknown>;
  dependencies: string[];
  status: "PENDING" | "RUNNING" | "PASSED" | "FAILED" | "BLOCKED";
  validationResult?: unknown;
  qaResult?: unknown;
  generatedOperations?: Plan["operations"];
  repairHistory: unknown[];
  error?: string;
  capabilities?: {
    pathReveal: boolean;
    reason: string;
    sourcePositionIds: string[];
    sceneIntervals: { startFrame: number; durationFrames: number }[];
  };
  recovery?: { type: string; reason: string };
}
type Context = {
  mentions?: { sourceNodeId: string; sceneId: string }[];
  activeSceneId?: string;
  runtimeTargetIsExplicit?: boolean;
  runtimeTarget?: { targetId: string; sceneId: string };
};
const normalize = (s: string) =>
  s
    .replace(/\\xa0/g, " ")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
const hasReference = (text:string, reference:string) => {
  if(!reference) return false;
  let from=0;
  for(;;) {
    const at=text.indexOf(reference,from);
    if(at<0) return false;
    const before=text[at-1]??'',after=text[at+reference.length]??'';
    if(!/[\p{L}\p{N}_]/u.test(before)&&!/[\p{L}\p{N}_]/u.test(after)) return true;
    from=at+reference.length;
  }
};
/** Bind local intent clauses before producing operations; mentions resolve an instance,
 * never form a global target filter. Ambiguous named instances remain blocked. */
export function planMotionTasks(
  project: LoadedProject,
  state: MotionState,
  request: string,
  context: unknown,
): MotionTask[] {
  if (/^(убери|удали|отключи|remove|disable)\s/i.test(request)) return [];
  const ctx = context as Context;
  const all = project.inspection.document.scenes
    .flatMap(objectsIn)
    .filter(
      (o) =>
        !project.inspection.document.scenes.some(
          (s) => s.sceneId === o.sceneId && s.figmaNodeId === o.targetId,
        ),
    );
  const registry = buildRegistry(project.inspection.document,project.inspection.fingerprint);
  const query = normalize(request);
  const initialChunks = query.split(
    /[.;\n]|,?\s+а\s+|\s+и\s+(?=(?:будут|добавь|добавить|пусть|инерц|затуха|overshoot))|\band\s+(?=add|inertia|overshoot)/i,
  );
  const chunks = initialChunks.flatMap((chunk) => {
    const markers = [
      ...chunk.matchAll(
        /trim\s*paths?|path\s*reveal|прорис\w*|инерц[^\s]*|inertial[^\s]*|overshoot|колеб[^\s]*|затуха[^\s]*\s+колеб[^\s]*/gi,
      ),
    ];
    if (markers.length < 2) return [chunk];
    const kind = (word: string) =>
      /trim|path|прорис/i.test(word) ? "trimPath" : "inertialOvershoot";
    const cuts = [0];
    for (let i = 1; i < markers.length; i++) {
      if (kind(markers[i][0]) === kind(markers[i - 1][0])) continue;
      const start = markers[i - 1].index! + markers[i - 1][0].length,
        end = markers[i].index!;
      const between = chunk.slice(start, end);
      const names = all.flatMap((o) => {
        const at = between.indexOf(normalize(o.name));
        return o.name && at >= 0 ? [start + at] : [];
      });
      const connectors = [
        ...between.matchAll(/[,;]|\s(?:и|and|then|затем)\s/g),
      ];
      cuts.push(
        connectors.length
          ? start + connectors.at(-1)!.index! + connectors.at(-1)![0].length
          : names.length
            ? Math.min(...names)
            : end,
      );
    }
    return cuts.map((cut, i) => chunk.slice(cut, cuts[i + 1] ?? chunk.length));
  });
  const tasks: MotionTask[] = [];
  for (const clause of chunks) {
    const techniques: MotionTask["techniqueId"][] = [];
    if (/trim\s*paths?|path\s*reveal|прорис|рисова.*лини/i.test(clause))
      techniques.push("trimPath");
    if (
      /инерц|inertial|overshoot|затуха.*колеб|колеб.*(затух|после)/i.test(
        clause,
      ) ||
      (/колеб/i.test(clause) &&
        state.expressions?.some((e) => e.type === "inertialOvershoot"))
    )
      techniques.push("inertialOvershoot");
    if (!techniques.length) continue;
    const names = [
      ...new Set(
        all
          .filter(
            (o) =>
              o.name &&
              (hasReference(clause, normalize(o.name)) ||
                hasReference(clause, o.targetId.toLowerCase()) ||
                registry.objects.some(
                  (l) =>
                    clause.includes(l.logicalObjectId) &&
                    l.sourceInstances.some(
                      (ref) =>
                        ref.sceneId === o.sceneId &&
                        ref.sourceNodeId === o.targetId,
                    ),
                )),
          )
          .map((o) => normalize(o.name)),
      ),
    ];
    for (const techniqueId of techniques) {
      let targets = names.flatMap((name) => {
        const candidates = all.filter((o) => normalize(o.name) === name);
        const explicit = candidates.filter(o=>hasReference(clause,o.targetId.toLowerCase()));
        const mentioned = candidates.filter((o) =>
          ctx.mentions?.some(
            (m) => m.sourceNodeId === o.targetId && m.sceneId === o.sceneId,
          ),
        );
        const scoped = candidates.filter(
          (o) =>
            o.sceneId === (ctx.activeSceneId ?? ctx.runtimeTarget?.sceneId),
        );
        return explicit.length
          ? explicit
          : mentioned.length
            ? mentioned
            : candidates.length === 1
              ? candidates
              : scoped.length
                ? scoped
                : candidates;
      });
      if (!targets.length) {
        const existing =
          techniqueId === "trimPath"
            ? state.animations.filter(
                (a) => a.enabled && a.effect === "trimPath",
              )
            : (state.expressions?.filter(
                (e) => e.enabled && e.type === techniqueId,
              ) ?? []);
        const inherited = tasks
          .filter((t) => t.userIntent === chunks[chunks.indexOf(clause) - 1])
          .map((t) => t.targetReference);
        const refs = existing.length
          ? existing
          : inherited.length
            ? inherited
            : ctx.mentions?.length
              ? ctx.mentions.map((m) => ({
                  sceneId: m.sceneId,
                  targetId: m.sourceNodeId,
                }))
              : ctx.runtimeTarget && ctx.runtimeTargetIsExplicit !== false
                ? [ctx.runtimeTarget]
                : [];
        targets = all.filter((o) =>
          refs.some(
            (r) => r.sceneId === o.sceneId && r.targetId === o.targetId,
          ),
        );
        if (
          !targets.length &&
          techniques.length === 1 &&
          techniqueId === "trimPath"
        ) {
          const eligible = all.filter((o) => o.trimSupported);
          if (eligible.length === 1) targets = eligible;
        }
      }
      // No guessed target: retain an explicit failed task for final reconciliation.
      const candidates = targets.length
        ? targets
        : [
            {
              targetId: "",
              sceneId: "",
              name: "Не определён объект",
              trimSupported: false,
              trimReason: "Target unresolved",
            },
          ];
      for (const target of candidates) {
        if (
          tasks.some(
            (t) =>
              t.techniqueId === techniqueId &&
              t.targetReference.targetId === target.targetId &&
              t.targetReference.sceneId === target.sceneId,
          )
        )
          continue;
        const duplicate =
          targets.filter((o) => normalize(o.name) === normalize(target.name))
            .length > 1;
        const logical = registry.objects.find((o) =>
          o.sourceInstances.some(
            (s) =>
              s.sourceNodeId === target.targetId &&
              s.sceneId === target.sceneId,
          ),
        );
        const taskId =
          "task_" +
          createHash("sha256")
            .update(
              JSON.stringify([techniqueId, target.sceneId, target.targetId]),
            )
            .digest("hex")
            .slice(0, 16);
        const error = 'mask' in target && target.mask
          ? 'MASK_TARGET: маска не является самостоятельной целью анимации; нужен явный визуальный контейнер'
          : !target.targetId
          ? "TARGET_UNRESOLVED: объект не определён"
          : duplicate &&
              !ctx.mentions?.some(
                (m) =>
                  m.sourceNodeId === target.targetId &&
                  m.sceneId === target.sceneId,
              )
            ? "AMBIGUOUS_TARGET: несколько экземпляров; нужна однозначная сцена"
            : techniqueId === "trimPath" && !target.trimSupported
              ? "MISSING_PATH_GEOMETRY: " +
                target.trimReason +
                ". Восстановление: повторный экспорт vectorPaths и центральной обводки из Figma; масштабирование не заменяет путь."
              : undefined;
        tasks.push({
          taskId,
          userIntent: clause,
          targetReference: {
            logicalObjectId: logical?.logicalObjectId,
            sceneId: target.sceneId,
            targetId: target.targetId,
            sourceNodeId: target.targetId,
            name: target.name,
          },
          techniqueId,
          parameters:
            techniqueId === "trimPath"
              ? { direction: "forward" }
              : {
                  trigger: /position|позици|движ|останов/i.test(clause)
                    ? "afterPosition"
                    : "afterSource",
                  strength: /сильн|strong/i.test(clause) ? "strong" : "default",
                },
          capabilities: {
            pathReveal: target.trimSupported,
            reason: target.trimReason,
            sourcePositionIds: state.animations
              .filter(
                (a) =>
                  a.sceneId === target.sceneId &&
                  a.targetId === target.targetId &&
                  a.enabled &&
                  Object.keys(evaluateAnimation(a, a.startFrame)).some(
                    (k) => k === "x" || k === "y",
                  ),
              )
              .map((a) => a.animationId),
            sceneIntervals: state.blocks
              .filter((b) => b.sceneId === target.sceneId)
              .map((b) => ({
                startFrame: b.startFrame,
                durationFrames: b.durationFrames,
              })),
          },
          dependencies: tasks
            .filter(
              (t) =>
                t.targetReference.sceneId === target.sceneId &&
                t.targetReference.targetId === target.targetId,
            )
            .map((t) => t.taskId),
          status: error ? "BLOCKED" : "PENDING",
          repairHistory: [],
          ...(error
            ? {
                error,
                recovery: {
                  type:
                    techniqueId === "trimPath"
                      ? "recover-source-geometry"
                      : "resolve-target",
                  reason: error,
                },
                validationResult: {
                  status: "FAILED",
                  phase: "preflight",
                  taskId,
                  reason: error,
                },
              }
            : {}),
        });
      }
    }
  }
  return tasks;
}

/** Compare complete state, including removal/ID reassignment. A provider cannot edit
 * another target or reset project settings while repairing a task. */
export function assertTaskScope(
  before: MotionState,
  after: MotionState,
  task: MotionTask,
) {
  const belongs = (v: { sceneId: string; targetId: string }) =>
    v.sceneId === task.targetReference.sceneId &&
    v.targetId === task.targetReference.targetId;
  const replacedRevealIds = before.animations
    .filter(
      (a) =>
        belongs(a) &&
        a.effect === "property" &&
        ["scaleX", "scaleY"].includes(a.parameters.property) &&
        /reveal|trim|ribbon|прорис/i.test(a.animationId),
    )
    .map((a) => a.animationId);
  if (
    task.techniqueId === "trimPath" &&
    after.animations.some(
      (a) =>
        belongs(a) &&
        replacedRevealIds.includes(a.animationId) &&
        a.effect !== "trimPath",
    )
  )
    throw new Error(
      "TECHNIQUE_MISMATCH: замените прежнюю scale-подмену настоящим trimPath",
    );
  const positionTrack = (a: MotionState["animations"][number]) => {
    const values = evaluateAnimation(a, a.startFrame);
    return (
      Object.keys(values).length > 0 &&
      Object.keys(values).every((k) => k === "x" || k === "y")
    );
  };
  const parameterEdit =
    /слабее|сильнее|в (два|три|\d+) раза|амплитуд|частот/i.test(
      task.userIntent,
    );
  const originalIds = new Set(before.animations.map((a) => a.animationId));
  const protectedState = (state: MotionState) => ({
    ...state,
    animations: state.animations.filter(
      (a) =>
        !belongs(a) ||
        (task.techniqueId === "trimPath"
          ? a.effect !== "trimPath" &&
            !replacedRevealIds.includes(a.animationId)
          : !positionTrack(a) ||
            (parameterEdit && originalIds.has(a.animationId))),
    ),
    expressions: (state.expressions ?? []).filter(
      (e) =>
        !belongs(e) ||
        task.techniqueId !== "inertialOvershoot" ||
        e.type !== "inertialOvershoot",
    ),
  });
  if (!isDeepStrictEqual(protectedState(before), protectedState(after)))
    throw new Error(
      "TASK_SCOPE_VIOLATION: изменены другие объекты, эффекты или настройки проекта",
    );
}

export function validateTaskExecution(state: MotionState, task: MotionTask) {
  const target = task.targetReference;
  const matching = (v: { sceneId: string; targetId: string }) =>
    v.sceneId === target.sceneId && v.targetId === target.targetId;
  if (
    task.techniqueId === "inertialOvershoot" &&
    task.parameters.trigger === "afterPosition"
  ) {
    const expressions = (state.expressions ?? []).filter(
      (e) => matching(e) && e.enabled && e.type === "inertialOvershoot",
    );
    if (
      !expressions.some((e) => {
        if (e.type !== "inertialOvershoot" || !["x", "y"].includes(e.property))
          return false;
        const source = state.animations.find(
          (a) =>
            a.animationId === e.sourceAnimationId && a.enabled && matching(a),
        );
        if (
          !source ||
          e.startFrame !== source.startFrame + source.durationFrames
        )
          return false;
        const start = evaluateAnimation(source, source.startFrame),
          end = evaluateAnimation(
            source,
            source.startFrame + source.durationFrames,
          );
        return (
          Math.abs((end[e.property] ?? 0) - (start[e.property] ?? 0)) > 0.01
        );
      })
    )
      throw new Error(
        "POSITION_DEPENDENCY_MISSING: нужна процедурная инерция x/y сразу после реально перемещающего объекта Position-трека",
      );
  }
}
