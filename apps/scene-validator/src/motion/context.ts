import { pathCapability } from "../motion-library/registry/path-capability.js";
import { buildRegistry, resolveState } from "./registry.js";
import type { LoadedProject, Scene } from "../types.js";
import type { MotionState } from "./schema.js";
export interface MotionObject {
  targetId: string;
  sceneId: string;
  name: string;
  type: string;
  text?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  mask: boolean;
  trimSupported: boolean;
  trimReason: string;
  parentId?: string;
}
export function objectsIn(scene: Scene): MotionObject[] {
  const objects: MotionObject[] = [];
  function walk(raw: unknown) {
    if (!raw || typeof raw !== "object") return;
    const n = raw as Record<string, unknown>,
      p = (n.properties ?? {}) as Record<string, unknown>;
    const m = n.sceneTransform as number[][] | undefined;
    const t = n.text as { characters?: string } | undefined;
    const strokes = Array.isArray(p.strokes) ? p.strokes : [],
      fills = Array.isArray(p.fills) ? p.fills : [];
    objects.push({
      targetId: String(n.figmaNodeId),
      sceneId: scene.sceneId,
      name: String(n.name ?? ""),
      type: String(n.type),
      text: t?.characters,
      x: m?.[0]?.[2] ?? 0,
      y: m?.[1]?.[2] ?? 0,
      width: Number(p.width ?? n.width ?? 0),
      height: Number(p.height ?? n.height ?? 0),
      visible: p.visible !== false,
      mask: p.isMask === true,
      parentId: typeof n.parentId === "string" ? n.parentId : undefined,
      trimSupported: pathCapability(String(n.type), p).supported,
      trimReason: pathCapability(String(n.type), p).reason,
    });
    if (Array.isArray(n.children)) n.children.forEach(walk);
  }
  walk(scene);
  return objects;
}
export function buildContext(
  project: LoadedProject,
  state: MotionState,
  userRequest: string,
  selectedObjectId?: string,
  selectedSceneId?: string,
  scope?: { sceneIds: Set<string>; targetIds: Set<string> },
) {
  const scenes = project.inspection.document.scenes
    .filter((s) => !scope || scope.sceneIds.has(s.sceneId))
    .map((s) => ({
      sceneId: s.sceneId,
      index: s.index,
      name: s.name,
      objects: objectsIn(s),
    }));
  const selected = selectedObjectId
    ? scenes
        .flatMap((s) => s.objects)
        .filter(
          (o) =>
            o.targetId === selectedObjectId &&
            (!selectedSceneId || o.sceneId === selectedSceneId),
        )
    : [];
  if (selectedObjectId && selected.length !== 1)
    throw new Error(
      "Неизвестный или неоднозначный выбранный объект. Выберите объект и сцену.",
    );
  const registry = buildRegistry(
    project.inspection.document,
    project.inspection.fingerprint,
  );
  return {
    project: { name: project.config.name, ...state.settings },
    scenes,
    motion: state,
    selectedObjectId: selected[0]?.targetId ?? null,
    selectedLogicalObjectId:
      registry.objects.find((o) =>
        o.sourceInstances.some(
          (i) =>
            i.sceneId === selected[0]?.sceneId &&
            i.sourceNodeId === selected[0]?.targetId,
        ),
      )?.logicalObjectId ?? null,
    selectedSceneId: selected[0]?.sceneId ?? null,
    userRequest,
    logicalObjects: registry.objects
      .filter(
        (o) =>
          !scope ||
          o.sourceInstances.some(
            (i) =>
              scope.sceneIds.has(i.sceneId) &&
              (!scope.targetIds.size || scope.targetIds.has(i.sourceNodeId)),
          ),
      )
      .map((o) => ({
        ...o,
        states: o.states
          .filter(
            (ref) =>
              !scope ||
              (scope.sceneIds.has(ref.sceneId) &&
                (!scope.targetIds.size ||
                  scope.targetIds.has(ref.sourceNodeId))),
          )
          .map((ref) => {
            const s = resolveState(project.inspection.document, o, ref.sceneId);
            return {
              ...ref,
              width: s.width,
              height: s.height,
              transform: s.transform,
              normalizedTransform: s.normalizedTransform,
              opacity: s.opacity,
              visible: s.visible,
              layerPath: s.layerPath,
              hierarchy: s.hierarchy,
              maskIds: s.maskIds,
              appearance: s.appearance,
            };
          }),
      })),
    identityDiagnostics: registry.diagnostics,
    timing:
      "All animation frames are absolute project frames. Frames are integers; seconds multiply by FPS and round. Blocks use project time. Source node IDs are instances. Logical IDs match exact case-sensitive names across scenes. Use animateObjectStateTransition for state changes; endpoints are resolved from source, never invented.",
  };
}
export function defaultMotion(project: LoadedProject): MotionState {
  const scenes = project.inspection.document.scenes;
  const durationFrames = Math.max(120, scenes.length * 60);
  return {
    schemaVersion: "1.0.0",
    settings: {
      fps: 30,
      width: Math.ceil(scenes[0].width),
      height: Math.ceil(scenes[0].height),
      durationFrames,
      strictDuration: true,
    },
    blocks: scenes.map((s, i) => ({
      blockId: `block_${s.sceneId}`,
      sceneId: s.sceneId,
      name: s.name,
      startFrame: Math.floor((i * durationFrames) / scenes.length),
      durationFrames:
        Math.floor(((i + 1) * durationFrames) / scenes.length) -
        Math.floor((i * durationFrames) / scenes.length),
      transition: { type: "cut", durationFrames: 0 },
    })),
    animations: [],
    visibility: [],
  };
}
