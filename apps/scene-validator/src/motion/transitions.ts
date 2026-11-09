import {evaluateAnimation, evaluateMotion} from "./evaluation.js";
import { intervalConflict } from "./intervals.js";
import type { LoadedProject } from "../types.js";
import type { MotionState,Animation } from "./schema.js";
import { buildRegistry, resolveState } from "./registry.js";
import { canvasMatrix, decompose, inverse, multiply } from "./geometry.js";
import type { StatePresentation } from "./transition-runtime.js";
import {expressionValue} from './expressions.js';
export class TransitionCompositionError extends Error {
  readonly code='TRANSITION_COMPOSITION_CONFLICT';
  readonly issue;
  constructor(details:Record<string,unknown>){super('TRANSITION_COMPOSITION_CONFLICT: анимация конфликтует с владельцем state-transition subtree');this.issue={code:this.code,message:this.message,details,allowedActions:['inspectAnimations','inspectDependencies','editTransitionGroup','edit']};}
}
const neutralValues=(values:Record<string,number|undefined>)=>Object.entries(values).every(([key,value])=>Number.isFinite(value)&&Math.abs(value!-( ["opacity","scale","scaleX","scaleY","trim"].includes(key)?1:0))<1e-9);
/** A converted base may hold its neutral endpoint through the old tail duration.
 * Equal keyframe endpoints prove a constant segment for every supported easing. */
function neutralSourceTrack(a:Animation,start:number){
 if(a.text&&a.text.segmentation!=='block')return false;
 if(a.startFrame+a.durationFrames<=start)return neutralValues(evaluateAnimation(a,a.startFrame+a.durationFrames));
 if(a.effect!=='keyframes'||!neutralValues(evaluateAnimation(a,start)))return false;
 return a.parameters.points.filter(p=>a.startFrame+p.frame>start).every(p=>neutralValues({[a.parameters.property]:p.value}));
}
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
  for (const e of state.expressions ?? []) {
    if (e.ownership?.scope !== "logicalObject") continue;
    const owner = registry.objects.find(o => o.logicalObjectId === e.ownership!.logicalObjectId);
    if (!owner?.sourceInstances.some(i => i.sceneId === e.sceneId && i.sourceNodeId === e.targetId)) throw new Error("EFFECT_OWNER_MISMATCH: logical owner must contain the source reference");
  }
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
    if (t.timelinePolicy === "referenceStates" ? fromBlocks.length > 1 || toBlocks.length > 1 : fromBlocks.length !== 1 || toBlocks.length !== 1)
      throw new Error(t.timelinePolicy === "referenceStates" ? "AMBIGUOUS_PRESENTATION: несколько video blocks ссылаются на одно reference state" : "Состояние должно иметь ровно один блок на timeline");
    const a = fromBlocks[0],
      b = toBlocks[0],
      end = t.startFrame + t.durationFrames;
    const blocks = [...state.blocks].sort(
      (a, b) => a.startFrame - b.startFrame,
    );
    intervalConflict(t, state.settings.durationFrames, "transition");
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
      const conflictingExpression = (state.expressions ?? []).find(
          (e) =>
            e.enabled && e.sceneId === s.sceneId && related.has(e.targetId) &&
            !(s.sceneId===t.fromSceneId&&!e.transitionId&&e.startFrame+e.durationFrames<=t.startFrame) &&
            !(s.sceneId===t.toSceneId&&!e.transitionId&&e.startFrame>=end&&Math.abs(expressionValue(e,end,state.settings.fps,state.animations,evaluateAnimation))<1e-9) &&
            !((e.transitionId === t.transitionId || Boolean(e.transitionId&&ts.some(owner=>owner.transitionId===e.transitionId&&owner.logicalObjectId===t.logicalObjectId)) || e.ownership?.scope === "logicalObject" && e.ownership.logicalObjectId === t.logicalObjectId) && e.targetId === s.sourceNodeId),
        );
      if(conflictingExpression)throw new TransitionCompositionError({transitionId:t.transitionId,expressionId:conflictingExpression.expressionId,targetId:conflictingExpression.targetId,sceneId:s.sceneId,property:conflictingExpression.property,ownership:conflictingExpression.ownership??{scope:'sceneInstance'},transitionInterval:[t.startFrame,end],expressionInterval:[conflictingExpression.startFrame,conflictingExpression.startFrame+conflictingExpression.durationFrames],overlap:[Math.max(t.startFrame,conflictingExpression.startFrame),Math.min(end,conflictingExpression.startFrame+conflictingExpression.durationFrames)],resolution:'End source effects before departure; begin neutral destination effects after arrival; or explicitly bind a supported transform effect to the transition/logical root.'});
      // Destination tracks may take over after arrival, but must begin at the
      // unmodified reference state. Evaluate the track (not every later phase)
      // so a grow/return sequence can retain its non-neutral second phase.
      const destinationTracks = state.animations.filter(a => a.enabled &&
        a.sceneId === t.toSceneId && related.has(a.targetId));
      const destinationValues = evaluateMotion({ ...state, animations: destinationTracks,
        expressions: [], objectTransitions: [] }, end).nodes;
      const destinationHandoff = destinationTracks.every(a => a.startFrame >= end && (!a.text || a.text.segmentation === "block")) &&
        Object.values(destinationValues).every(neutralValues);
      const conflictingAnimation=state.animations.find(
          (a) =>
            a.enabled && a.sceneId === s.sceneId && related.has(a.targetId) &&
            !(s.sceneId === t.toSceneId && destinationHandoff) &&
            !(s.sceneId===t.fromSceneId&&neutralSourceTrack(a,t.startFrame)),
        );
      if(conflictingAnimation)throw new TransitionCompositionError({transitionId:t.transitionId,animationId:conflictingAnimation.animationId,targetId:conflictingAnimation.targetId,sceneId:s.sceneId,transitionInterval:[t.startFrame,end],animationInterval:[conflictingAnimation.startFrame,conflictingAnimation.startFrame+conflictingAnimation.durationFrames],resolution:'Source subtree tracks must hold neutral values before departure; destination subtree tracks must start at/after arrival with neutral initial values. Otherwise choose an explicit transition-owned transform.'});
    }
  }
  for (const e of state.expressions ?? []) {
    if (!e.transitionId) continue;
    const t = ts.find(t => t.transitionId === e.transitionId)!;
    const object = registry.objects.find(o => o.logicalObjectId === t.logicalObjectId)!;
    const ref = resolveState(project.inspection.document, object, e.sceneId);
    if (ref.sourceNodeId !== e.targetId) throw new Error("EFFECT_TARGET_MISMATCH: transition-bound expression must target its logical object root");
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
