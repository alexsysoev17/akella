import type { LoadedProject } from "../types.js";
import type { MotionState } from "./schema.js";
import { buildRegistry, resolveState } from "./registry.js";
import { canvasMatrix, decompose, inverse, multiply } from "./geometry.js";
import type { StatePresentation } from "./transition-runtime.js";
export function statePresentation(
  project: LoadedProject,
  state: MotionState,
): StatePresentation {
  const result: StatePresentation = {};
  for (const object of buildRegistry(project.inspection.document,project.inspection.fingerprint).objects) {
    result[object.logicalObjectId] = {};
    for (const ref of object.states) {
      try {
        const s = resolveState(
          project.inspection.document,
          object,
          ref.sceneId,
        );
        if (
          !Number.isFinite(s.width) ||
          !Number.isFinite(s.height) ||
          s.width <= 0 ||
          s.height <= 0
        )
          continue;
        const fit = canvasMatrix(s.scene, state.settings);
        const normalized = multiply(fit, s.normalizedTransform);
        decompose(normalized);
        inverse(normalized);
        result[object.logicalObjectId][ref.sceneId] = {
          sourceNodeId: s.sourceNodeId,
          normalized,
          parentCanvas: multiply(fit, s.parentTransform),
          local: multiply(inverse(s.parentTransform), s.transform),
          width: s.width,
          height: s.height,
          opacity: s.opacity,
          visible: s.visible,
        };
      } catch {
        /* Invalid geometry remains in registry; only transitions using it are rejected. */
      }
    }
  }
  return result;
}
export function validateObjectTransitions(
  state: MotionState,
  project: LoadedProject,
) {
  const ts = state.objectTransitions ?? [],
    registry = buildRegistry(project.inspection.document,project.inspection.fingerprint);
  if (!ts.length) return;
  const presentation = statePresentation(project, state),
    ids = new Set<string>();
  for (const t of ts) {
    if (ids.has(t.transitionId)) throw new Error("Повтор transitionId");
    ids.add(t.transitionId);
    const object = registry.objects.find(
      (o) => o.logicalObjectId === t.logicalObjectId,
    );
    if (!object)
      throw new Error(`Логический объект исчез: ${t.logicalObjectId}`);
    const from = resolveState(
        project.inspection.document,
        object,
        t.fromSceneId,
      ),
      to = resolveState(project.inspection.document, object, t.toSceneId);
    if (t.fromSceneId === t.toSceneId)
      throw new Error("Для перехода нужны разные сцены");
    if (from.node.properties?.isMask || to.node.properties?.isMask)
      throw new Error(
        "Переход самой маски не поддерживается; используйте её визуальную группу",
      );
    if (
      !presentation[t.logicalObjectId]?.[t.fromSceneId] ||
      !presentation[t.logicalObjectId]?.[t.toSceneId]
    )
      throw new Error("Переход требует ненулевых размеров и обратимых матриц");
    const fromBlocks = state.blocks.filter((b) => b.sceneId === t.fromSceneId),
      toBlocks = state.blocks.filter((b) => b.sceneId === t.toSceneId);
    if (fromBlocks.length !== 1 || toBlocks.length !== 1)
      throw new Error("Состояние должно иметь ровно один блок на timeline");
    const a = fromBlocks[0],
      b = toBlocks[0],
      end = t.startFrame + t.durationFrames;
    const blocks = [...state.blocks].sort(
      (a, b) => a.startFrame - b.startFrame,
    );
    if (blocks.indexOf(b) !== blocks.indexOf(a) + 1)
      throw new Error(
        "Переходы поддерживают соседние состояния timeline; разбейте длинный путь на последовательные переходы",
      );
    if (
      t.startFrame < a.startFrame ||
      t.startFrame >= a.startFrame + a.durationFrames ||
      end < b.startFrame ||
      end >= b.startFrame + b.durationFrames ||
      end >= state.settings.durationFrames
    )
      throw new Error(
        "Переход начинается в исходном блоке и заканчивается в целевом, включая его первый кадр. Конечный кадр должен существовать.",
      );
    if (
      Math.sign(
        decompose(presentation[t.logicalObjectId][t.fromSceneId].normalized)
          .scaleY,
      ) !==
      Math.sign(
        decompose(presentation[t.logicalObjectId][t.toSceneId].normalized)
          .scaleY,
      )
    )
      throw new Error(
        "Смена отражения через нулевой масштаб пока не поддерживается",
      );
    // A managed subtree has one owner; reject competing parent/child instance animations.
    for (const s of [from, to]) {
      const descendants = (n: typeof s.node): string[] => [
        n.figmaNodeId,
        ...(n.children ?? []).flatMap(descendants),
      ];
      const related = new Set([
        ...descendants(s.node),
        ...s.ancestors.map((n) => n.figmaNodeId),
      ]);
      if (
        (state.expressions ?? []).some(
          (e) =>
            e.enabled && e.sceneId === s.sceneId && related.has(e.targetId),
        )
      )
        throw new Error(
          "Expression on a state-transition subtree is not yet supported; use transition proceduralEffects or a non-overlapping instance workflow",
        );
      if (
        state.animations.some(
          (a) =>
            a.enabled && a.sceneId === s.sceneId && related.has(a.targetId),
        )
      )
        throw new Error(
          `«${object.name}»: отдельная анимация экземпляра/родителя/потомка конфликтует с переходом; перенесите характер движения в proceduralEffects`,
        );
    }
  }
  for (let i = 0; i < ts.length; i++)
    for (let j = i + 1; j < ts.length; j++) {
      const a = ts[i],
        b = ts[j];
      if (
        Math.max(a.startFrame, b.startFrame) >=
        Math.min(
          a.startFrame + a.durationFrames,
          b.startFrame + b.durationFrames,
        )
      )
        continue;
      if (a.logicalObjectId === b.logicalObjectId)
        throw new Error("Перекрывающиеся переходы одного объекта запрещены");
      if (
        a.startFrame !== b.startFrame ||
        a.durationFrames !== b.durationFrames ||
        a.fromSceneId !== b.fromSceneId ||
        a.toSceneId !== b.toSceneId ||
        Math.abs(
          a.startFrame +
            a.durationFrames * a.layerPolicy.switchProgress -
            b.startFrame -
            b.durationFrames * b.layerPolicy.switchProgress,
        ) > 1e-7
      )
        throw new Error(
          "Одновременные переходы должны использовать одну пару сцен и общий кадр переключения иерархии",
        );
      for (const sceneId of [a.fromSceneId, a.toSceneId]) {
        const x = resolveState(
          project.inspection.document,
          registry.objects.find(
            (o) => o.logicalObjectId === a.logicalObjectId,
          )!,
          sceneId,
        );
        const y = resolveState(
          project.inspection.document,
          registry.objects.find(
            (o) => o.logicalObjectId === b.logicalObjectId,
          )!,
          sceneId,
        );
        if (
          x.ancestors.some((n) => n.figmaNodeId === y.sourceNodeId) ||
          y.ancestors.some((n) => n.figmaNodeId === x.sourceNodeId)
        )
          throw new Error(
            "Одновременно анимировать переход родителя и потомка нельзя: выберите владельцем группу",
          );
      }
    }
}
export function transitionDiagnostics(
  state: MotionState,
  project: LoadedProject,
) {
  const registry = buildRegistry(project.inspection.document,project.inspection.fingerprint),
    warnings = [...registry.diagnostics];
  for (const t of state.objectTransitions ?? []) {
    const o = registry.objects.find(
      (o) => o.logicalObjectId === t.logicalObjectId,
    )!;
    const a = resolveState(project.inspection.document, o, t.fromSceneId),
      b = resolveState(project.inspection.document, o, t.toSceneId);
    const frame =
      t.startFrame + t.durationFrames * t.layerPolicy.switchProgress;
    warnings.push(
      `«${o.name}»: дерево композиции и содержимое переключаются целиком на кадре ${Math.ceil(frame)}; геометрия непрерывна. Это дискретная смена сцены, не морфинг содержимого.`,
    );
    if (
      state.blocks.find((b) => b.sceneId === t.fromSceneId)?.transition.type ===
      "crossfade"
    )
      warnings.push(
        `«${o.name}»: crossfade пары сцен заменён дискретной композицией во время state transition, чтобы сохранить единственный экземпляр и порядок слоёв.`,
      );
    if (
      a.maskIds.length ||
      b.maskIds.length ||
      a.hierarchy.some((h) => h.clipsContent) ||
      b.hierarchy.some((h) => h.clipsContent)
    )
      warnings.push(
        `«${o.name}»: clipping и маски наследуются от выбранной иерархии; их форма переключается дискретно вместе с ней.`,
      );
    if (a.inheritedOpacity !== b.inheritedOpacity)
      warnings.push(
        `«${o.name}»: прозрачность родительской группы переключается вместе с иерархией; локальная opacity объекта интерполируется.`,
      );
  }
  return warnings;
}
