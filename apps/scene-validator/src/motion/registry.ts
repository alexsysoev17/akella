import { createHash } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { atomicJson, exists, noSymlinkPath, safeDirectory } from "../files.js";
import type { LoadedProject, SceneDocument } from "../types.js";
import { matrix, multiply, unit, type Matrix } from "./geometry.js";
export interface SourceNode {
  figmaNodeId: string;
  name: string;
  type: string;
  children: SourceNode[];
  sceneTransform: Matrix;
  properties: Record<string, unknown>;
  parentId?: string;
  svgAssetId?: string;
  fallbackAssetId?: string;
  text?: unknown;
}
export interface Instance {
  sceneId: string;
  sourceNodeId: string;
}
export interface LogicalObject {
  logicalObjectId: string;
  name: string;
  matchingStrategy: "exact-name";
  sourceInstances: Instance[];
  states: Instance[];
  ambiguousScenes: string[];
}
export interface ObjectRegistry {
  schemaVersion: "1.0.0";
  sourceFingerprint: string;
  objects: LogicalObject[];
  diagnostics: string[];
}
/** No normalization: code points, case, whitespace and spelling all participate in identity. */
export const logicalId = (name: string) =>
  "object_" + createHash("sha256").update(name).digest("hex");
const registryCache = new Map<string, ObjectRegistry>();
export function buildRegistry(
  document: SceneDocument,
  sourceFingerprint = "",
): ObjectRegistry {
  const cached = sourceFingerprint && registryCache.get(sourceFingerprint);
  if (cached) return structuredClone(cached);
  const byName = new Map<string, LogicalObject>();
  for (const scene of document.scenes) {
    const visit = (node: SourceNode) => {
      if (typeof node.name !== "string") {
        node.children?.forEach(visit);
        return;
      }
      let entry = byName.get(node.name);
      if (!entry) {
        entry = {
          logicalObjectId: logicalId(node.name),
          name: node.name,
          matchingStrategy: "exact-name",
          sourceInstances: [],
          states: [],
          ambiguousScenes: [],
        };
        byName.set(node.name, entry);
      }
      entry.sourceInstances.push({
        sceneId: scene.sceneId,
        sourceNodeId: node.figmaNodeId,
      });
      node.children?.forEach(visit);
    };
    (scene.children as SourceNode[]).forEach(visit);
  }
  const diagnostics: string[] = [];
  for (const o of byName.values())
    for (const scene of document.scenes) {
      const refs = o.sourceInstances.filter((r) => r.sceneId === scene.sceneId);
      if (refs.length === 1) o.states.push(refs[0]);
      if (refs.length > 1) {
        o.ambiguousScenes.push(scene.sceneId);
        diagnostics.push(
          `«${o.name}»: ${refs.length} экземпляра в ${scene.name}; автоматическое сопоставление этой сцены неоднозначно.`,
        );
      }
    }
  const result: ObjectRegistry = {
    schemaVersion: "1.0.0",
    sourceFingerprint,
    objects: [...byName.values()],
    diagnostics,
  };
  if (sourceFingerprint) {
    if (registryCache.size >= 20)
      registryCache.delete(registryCache.keys().next().value!);
    registryCache.set(sourceFingerprint, structuredClone(result));
  }
  return result;
}
export async function ensureRegistry(project: LoadedProject) {
  const registry = buildRegistry(
    project.inspection.document,
    project.inspection.fingerprint,
  );
  const file = path.join(project.root, "motion/object-registry.json");
  await safeDirectory(project.root, "motion");
  if (await exists(file)) await noSymlinkPath(project.root, file);
  const json = JSON.stringify(registry);
  if (
    !(await exists(file)) ||
    JSON.stringify(JSON.parse(await readFile(file, "utf8"))) !== json
  )
    await atomicJson(file, registry);
  return registry;
}
export function resolveState(
  document: SceneDocument,
  object: LogicalObject,
  sceneId: string,
) {
  const ref = object.states.find((s) => s.sceneId === sceneId);
  if (!ref)
    throw new Error(
      `«${object.name}»: состояние ${sceneId} отсутствует или неоднозначно`,
    );
  const scene = document.scenes.find((s) => s.sceneId === sceneId)!;
  let found:
    | {
        node: SourceNode;
        ancestors: SourceNode[];
        layerPath: number[];
        maskIds: string[];
      }
    | undefined;
  function walk(
    node: SourceNode,
    ancestors: SourceNode[],
    layerPath: number[],
    maskIds: string[],
  ) {
    if (node.figmaNodeId === ref!.sourceNodeId)
      found = { node, ancestors, layerPath, maskIds };
    let mask: string | undefined;
    const children = node.children ?? [];
    children.forEach((child, i) => {
      if (child.properties?.isMask && child.properties.visible !== false)
        mask = child.figmaNodeId;
      walk(
        child,
        [...ancestors, node],
        [
          ...layerPath,
          node.properties?.itemReverseZIndex === true
            ? children.length - 1 - i
            : i,
        ],
        mask ? [...maskIds, mask] : maskIds,
      );
    });
  }
  walk(scene as unknown as SourceNode, [], [], []);
  if (!found) throw new Error("Ссылка на исходный слой отсутствует");
  const { node, ancestors, layerPath, maskIds } = found;
  const p = node.properties ?? {},
    width = Number(p.width ?? 0),
    height = Number(p.height ?? 0);
  const transform = matrix(node.sceneTransform);
  return {
    sceneId,
    sourceNodeId: node.figmaNodeId,
    node,
    scene,
    ancestors,
    layerPath,
    maskIds,
    width,
    height,
    transform,
    parentTransform: ancestors.length
      ? matrix(ancestors.at(-1)!.sceneTransform)
      : unit,
    normalizedTransform: multiply(transform, [
      [width, 0, 0],
      [0, height, 0],
    ]),
    opacity: Number(p.opacity ?? 1),
    inheritedOpacity: ancestors.reduce(
      (a, n) => a * Number(n.properties?.opacity ?? 1),
      1,
    ),
    visible: [...ancestors, node].every((n) => n.properties?.visible !== false),
    hierarchy: ancestors.map((n) => ({
      sourceNodeId: n.figmaNodeId,
      name: n.name,
      transform: n.sceneTransform,
      opacity: n.properties?.opacity ?? 1,
      blendMode: n.properties?.blendMode ?? "PASS_THROUGH",
      clipsContent: n.properties?.clipsContent === true,
    })),
    appearance: {
      fills: p.fills,
      strokes: p.strokes,
      effects: p.effects,
      text: node.text,
      svgAssetId: node.svgAssetId,
      fallbackAssetId: node.fallbackAssetId,
    },
  };
}
