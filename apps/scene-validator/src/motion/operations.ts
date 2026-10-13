import { retimeScenes, resolveTimingDependencies } from "./intent/retime.js";
import { instantiatePreset } from "../motion-library/presets/registry.js";
import { validateExpressions } from "./validate-expressions.js";
import { validateObjectTransitions } from "./transitions.js";
import {
  motionSchema,
  operationsSchema,
  type Animation,
  type MotionState,
} from "./schema.js";
import type { LoadedProject } from "../types.js";
import { objectsIn } from "./context.js";
export function channels(a: Animation): string[] {
  if (a.effect === "property") return [a.parameters.property];
  if (a.effect === "keyframes") return [a.parameters.property];
  if (a.effect === "oscillation" || a.effect === "dampedOscillation")
    return [a.parameters.property];
  if (a.effect.startsWith("fade")) return ["opacity"];
  if (a.effect.startsWith("scale")) return ["scale"];
  if (a.effect === "slideUp" || a.effect === "slideDown") return ["y"];
  if (a.effect === "slideLeft" || a.effect === "slideRight") return ["x"];
  if (a.effect === "moveTo") return ["x", "y"];
  if (a.effect === "maskReveal") return ["reveal"];
  return [a.effect === "trimPath" ? "trim" : "rotation"];
}
export function validateMotion(
  input: unknown,
  project: LoadedProject,
): MotionState {
  const state = motionSchema.parse(input);
  const ids = new Set<string>(),
    sceneIds = new Set(
      project.inspection.document.scenes.map((s) => s.sceneId),
    );
  const objects = new Map(
    project.inspection.document.scenes
      .flatMap(objectsIn)
      .map((o) => [`${o.sceneId}/${o.targetId}`, o]),
  );
  const target = (sceneId: string, targetId: string) => {
    const o = objects.get(`${sceneId}/${targetId}`);
    if (!o) throw new Error(`Неизвестный объект: ${sceneId}/${targetId}`);
    return o;
  };
  for (const a of state.animations) {
    if (ids.has(a.animationId))
      throw new Error(`Повтор animationId: ${a.animationId}`);
    ids.add(a.animationId);
    const o = target(a.sceneId, a.targetId);
    if (a.effect === "maskReveal" && o.type !== "TEXT")
      throw new Error("Mask Reveal currently supports TEXT only");
    if (o.mask) throw new Error("Анимация масок пока не поддерживается.");
    if (a.startFrame + a.durationFrames > state.settings.durationFrames)
      throw new Error(
        `Анимация ${a.animationId} выходит за длительность ролика.`,
      );
    if (channels(a).includes("trim") && !o.trimSupported)
      throw new Error(`Trim Path недоступен: ${o.trimReason}.`);
    if (a.effect === "property") {
      if (
        a.parameters.property === "opacity" &&
        [a.parameters.from, a.parameters.to].some((v) => v < 0 || v > 1)
      )
        throw new Error("Opacity endpoints must be 0..1");
      if (
        a.parameters.property.startsWith("scale") &&
        Math.min(a.parameters.from, a.parameters.to) <= 0
      )
        throw new Error("Scale endpoints must be positive");
    }
    if (a.effect === "keyframes") {
      let previous = -1;
      for (const k of a.parameters.points) {
        if (k.frame <= previous || k.frame > a.durationFrames)
          throw new Error(
            "Ключевые кадры должны строго возрастать внутри длительности анимации.",
          );
        previous = k.frame;
        if (
          ["opacity", "trim"].includes(a.parameters.property) &&
          (k.value < 0 || k.value > 1)
        )
          throw new Error("Opacity и trim должны быть от 0 до 1.");
        if (a.parameters.property === "scale" && k.value <= 0)
          throw new Error("Scale должен быть положительным.");
      }
      if (
        a.parameters.points[0].frame !== 0 ||
        a.parameters.points.at(-1)!.frame !== a.durationFrames
      )
        throw new Error("Ключевые кадры должны включать 0 и durationFrames.");
    }
  }
  const enabled = state.animations.filter((a) => a.enabled);
  for (let i = 0; i < enabled.length; i++)
    for (let j = i + 1; j < enabled.length; j++) {
      const a = enabled[i],
        b = enabled[j];
      if (
        a.sceneId === b.sceneId &&
        a.targetId === b.targetId &&
        channels(a)
          .flatMap((c) => (c === "scale" ? ["scaleX", "scaleY"] : [c]))
          .some((c) =>
            channels(b)
              .flatMap((c) => (c === "scale" ? ["scaleX", "scaleY"] : [c]))
              .includes(c),
          ) &&
        Math.max(a.startFrame, b.startFrame) <
          Math.min(
            a.startFrame + a.durationFrames,
            b.startFrame + b.durationFrames,
          )
      )
        throw new Error(
          `Конфликт свойства: ${a.animationId} и ${b.animationId}. Разнесите их по времени.`,
        );
    }
  const blocks = [...state.blocks].sort((a, b) => a.startFrame - b.startFrame);
  const blockIds = new Set<string>();
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (blockIds.has(b.blockId)) throw new Error("Повтор blockId");
    blockIds.add(b.blockId);
    if (!sceneIds.has(b.sceneId)) throw new Error("Неизвестная сцена блока");
    if (b.startFrame + b.durationFrames > state.settings.durationFrames)
      throw new Error("Блок выходит за длительность ролика");
    if (b.transition.type === "cut" && b.transition.durationFrames !== 0)
      throw new Error("Cut должен иметь длительность перехода 0");
    const next = blocks[i + 1];
    if (!next) {
      if (
        b.startFrame + b.durationFrames !== state.settings.durationFrames ||
        b.transition.durationFrames !== 0
      )
        throw new Error(
          "Последний блок должен завершаться на конце ролика без перехода.",
        );
    } else {
      const overlap = b.startFrame + b.durationFrames - next.startFrame;
      if (
        overlap !== b.transition.durationFrames ||
        overlap < 0 ||
        overlap >= Math.min(b.durationFrames, next.durationFrames)
      )
        throw new Error(
          "Границы блоков должны стыковаться; перекрытие Crossfade равно длительности перехода.",
        );
      if (
        i > 0 &&
        blocks[i - 1].startFrame + blocks[i - 1].durationFrames >
          next.startFrame
      )
        throw new Error("Одновременно допускаются не более двух блоков.");
    }
  }
  if (blocks[0].startFrame !== 0)
    throw new Error("Первый блок должен начинаться с кадра 0");
  for (const v of state.visibility) target(v.sceneId, v.targetId);
  if (state.timingDependencies?.length) {
    const resolved = structuredClone(state);
    resolveTimingDependencies(resolved);
    if (
      resolved.animations.some(
        (a) =>
          a.startFrame !==
          state.animations.find((old) => old.animationId === a.animationId)
            ?.startFrame,
      )
    )
      throw new Error("Persisted timing dependency is out of sync");
  }
  validateExpressions(state, objects);
  validateObjectTransitions(state, project);
  return state;
}
export function applyOperations(
  previous: MotionState,
  input: unknown,
  project: LoadedProject,
): MotionState {
  const ops = operationsSchema.parse(input),
    state = structuredClone(previous);
  for (const op of ops) {
    const animation =
      "animationId" in op
        ? state.animations.find((a) => a.animationId === op.animationId)
        : undefined;
    const block =
      "blockId" in op
        ? state.blocks.find((b) => b.blockId === op.blockId)
        : undefined;
    if ("animationId" in op && !animation)
      throw new Error(`Анимация не найдена: ${op.animationId}`);
    if ("blockId" in op && !block)
      throw new Error(`Блок не найден: ${op.blockId}`);
    switch (op.type) {
      case "retimeScenes":
        retimeScenes(state, op.starts);
        break;
      case "setTimingDependency":
        state.timingDependencies = [
          ...(state.timingDependencies ?? []).filter(
            (d) =>
              d.dependencyId !== op.dependency.dependencyId &&
              d.animationId !== op.dependency.animationId,
          ),
          op.dependency,
        ];
        break;
      case "removeTimingDependency":
        state.timingDependencies = state.timingDependencies?.filter(
          (d) => d.dependencyId !== op.dependencyId,
        );
        break;
      case "scaleEasingParameter": {
        const easing = animation!.easing;
        if (typeof easing === "string")
          throw new Error(
            "A named easing has no editable parameters; use structured setEasing first",
          );
        const parameters = easing.parameters as Record<string, unknown>;
        if (typeof parameters[op.parameter] !== "number")
          throw new Error("Easing parameter is unavailable");
        const value = Number(parameters[op.parameter]) * op.factor;
        parameters[op.parameter] =
          op.parameter === "bounceCount" ? Math.round(value) : value;
        break;
      }
      case "applyMotionPreset": {
        const generated = instantiatePreset(
          op.presetId,
          op.instanceId,
          op.sceneId,
          op.targetId,
          op.startFrame,
          state.settings.fps,
        );
        state.animations.push(...generated.animations);
        state.expressions ??= [];
        state.expressions.push(...generated.expressions);
        break;
      }
      case "setExpression": {
        state.expressions ??= [];
        const i = state.expressions.findIndex(
          (e) => e.expressionId === op.expression.expressionId,
        );
        const next = structuredClone(op.expression);
        if (
          next.type === "inertialOvershoot" &&
          next.parameters.mode === undefined
        ) {
          const old = i < 0 ? undefined : state.expressions[i];
          if (i < 0) next.parameters.mode = "ae";
          else if (
            old?.type === "inertialOvershoot" &&
            old.parameters.mode !== undefined
          )
            next.parameters.mode = old.parameters.mode;
        }
        if (i < 0) state.expressions.push(next);
        else state.expressions[i] = next;
        break;
      }
      case "removeExpression":
        state.expressions = (state.expressions ?? []).filter(
          (e) => e.expressionId !== op.expressionId,
        );
        break;
      case "scaleExpressionParameter": {
        const e = state.expressions?.find(
          (e) => e.expressionId === op.expressionId,
        );
        if (!e) throw new Error("Expression not found");
        if (op.parameter === "durationFrames")
          e.durationFrames = Math.max(
            1,
            Math.round(e.durationFrames * op.factor),
          );
        else {
          const p = e.parameters as Record<string, number | string>;
          if (typeof p[op.parameter] !== "number")
            throw new Error("Parameter is not available on this expression");
          p[op.parameter] = Number(p[op.parameter]) * op.factor;
        }
        break;
      }
      case "animateObjectStateTransition": {
        const { type, ...transition } = op;
        state.objectTransitions ??= [];
        const i = state.objectTransitions.findIndex(
          (t) => t.transitionId === transition.transitionId,
        );
        if (i < 0) state.objectTransitions.push(transition);
        else state.objectTransitions[i] = transition;
        break;
      }
      case "removeObjectStateTransition":
        state.objectTransitions = (state.objectTransitions ?? []).filter(
          (t) => t.transitionId !== op.transitionId,
        );
        break;
      case "addAnimation":
        state.animations.push(op.animation);
        break;
      case "removeAnimation":
        state.animations = state.animations.filter(
          (a) => a.animationId !== op.animationId,
        );
        break;
      case "updateAnimation":
        if (op.animation.animationId !== op.animationId)
          throw new Error("Нельзя менять animationId");
        state.animations[state.animations.indexOf(animation!)] = op.animation;
        break;
      case "shiftAnimation":
        animation!.startFrame += op.deltaFrames;
        break;
      case "setStartFrame":
        animation!.startFrame = op.startFrame;
        break;
      case "setDuration":
        animation!.durationFrames = op.durationFrames;
        break;
      case "setEasing":
        animation!.easing = op.easing;
        break;
      case "setEffectParameters":
        Object.assign(animation!.parameters, op.parameters);
        break;
      case "setKeyframes":
        state.animations[state.animations.indexOf(animation!)] = {
          ...animation!,
          effect: "keyframes",
          parameters: { property: op.property, points: op.points },
        };
        break;
      case "setBlockDuration":
        block!.durationFrames = op.durationFrames;
        break;
      case "setBlockStart":
        block!.startFrame = op.startFrame;
        break;
      case "setSceneTransition":
        block!.transition = op.transition;
        break;
      case "setProjectDuration":
        state.settings.durationFrames = op.durationFrames;
        break;
      case "setProjectSettings":
        state.settings = op.settings;
        break;
      case "setBlocks":
        state.blocks = op.blocks;
        break;
      case "setVisibility":
        state.visibility = state.visibility.filter(
          (v) => v.sceneId !== op.sceneId || v.targetId !== op.targetId,
        );
        state.visibility.push({
          sceneId: op.sceneId,
          targetId: op.targetId,
          visible: op.visible,
        });
        break;
      case "stagger":
        op.animationIds.forEach((id, i) => {
          const a = state.animations.find((a) => a.animationId === id);
          if (!a) throw new Error(`Анимация не найдена: ${id}`);
          a.startFrame = op.startFrame + i * op.stepFrames;
        });
        break;
    }
  }
  resolveTimingDependencies(state);
  for (const e of state.expressions ?? []) {
    if (e.type !== "inertialOvershoot" || e.parameters.mode !== "ae") continue;
    const old = previous.expressions?.find(
      (p) => p.expressionId === e.expressionId,
    );
    if (
      !old ||
      old.type !== "inertialOvershoot" ||
      e.startFrame !== old.startFrame
    )
      continue;
    const before = previous.animations.find(
        (a) => a.animationId === e.sourceAnimationId,
      ),
      after = state.animations.find(
        (a) => a.animationId === e.sourceAnimationId,
      );
    if (
      before &&
      after &&
      old.startFrame >= before.startFrame + before.durationFrames
    )
      e.startFrame +=
        after.startFrame +
        after.durationFrames -
        (before.startFrame + before.durationFrames);
  }
  return validateMotion(state, project);
}
export function motionDiff(before: MotionState, after: MotionState) {
  const changes: { path: string; before: unknown; after: unknown }[] = [];
  function diff(a: unknown, b: unknown, path: string) {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (
      a &&
      b &&
      typeof a === "object" &&
      typeof b === "object" &&
      !Array.isArray(a) &&
      !Array.isArray(b)
    ) {
      const aa = a as Record<string, unknown>,
        bb = b as Record<string, unknown>;
      for (const key of new Set([...Object.keys(aa), ...Object.keys(bb)]))
        diff(aa[key], bb[key], `${path}.${key}`);
    } else changes.push({ path, before: a ?? null, after: b ?? null });
  }
  diff(before.expressions ?? [], after.expressions ?? [], "expressions");
  diff(before.settings, after.settings, "settings");
  diff(before.blocks, after.blocks, "blocks");
  diff(before.visibility, after.visibility, "visibility");
  diff(
    before.objectTransitions ?? [],
    after.objectTransitions ?? [],
    "objectTransitions",
  );
  for (const id of new Set(
    [...before.animations, ...after.animations].map((a) => a.animationId),
  ))
    diff(
      before.animations.find((a) => a.animationId === id),
      after.animations.find((a) => a.animationId === id),
      `animation.${id}`,
    );
  return changes;
}
