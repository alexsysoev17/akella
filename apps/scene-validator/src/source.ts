import path from "node:path";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  fingerprint,
  inventory,
  record,
  nonempty,
  relativePath,
} from "./files.js";
import type { Asset, Scene, SceneDocument, SourceInspection } from "./types.js";
const parsedCache = new Map<string, SourceInspection>();
export async function inspectSource(
  root: string,
  sceneRelative = "scene.json",
  reportRelative = "export-report.json",
): Promise<SourceInspection> {
  relativePath(sceneRelative, "scene path");
  const files = await inventory(root);
  const cacheKey =
    root +
    "/" +
    sceneRelative +
    "/" +
    reportRelative +
    "/" +
    fingerprint(files);
  const cached = parsedCache.get(cacheKey);
  if (cached) return structuredClone(cached);
  const verifiedJson = async (relative: string): Promise<unknown> => {
    const bytes = await readFile(path.join(root, relative));
    const expected = files.find((file) => file.path === relative)?.sha256;
    if (createHash("sha256").update(bytes).digest("hex") !== expected)
      throw new Error(
        "Source changed during inspection; retry after import completes",
      );
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new Error(`Cannot read valid JSON ${relative}: ${String(error)}`);
    }
  };
  const raw = record(await verifiedJson(sceneRelative), "scene.json");
  if (raw.schemaVersion !== "1.0.0")
    throw new Error(
      `Unsupported scene schemaVersion: ${String(raw.schemaVersion)}`,
    );
  if (
    !Array.isArray(raw.assets) ||
    !Array.isArray(raw.scenes) ||
    raw.scenes.length === 0
  )
    throw new Error(
      "scene.json must contain assets[] and one or more scenes[]",
    );
  const fileMap = new Map(files.map((f) => [f.path, f]));
  const sceneDirectory = path.posix.dirname(sceneRelative);
  const resolveResource = (resource: string) =>
    sceneDirectory === "." ? resource : `${sceneDirectory}/${resource}`;
  const assets: Asset[] = [];
  const assetIds = new Set<string>();
  for (const item of raw.assets) {
    const a = record(item, "asset");
    const assetId = nonempty(a.assetId, "assetId");
    if (
      a.byteLength !== undefined &&
      (!Number.isSafeInteger(a.byteLength) || (a.byteLength as number) < 0)
    )
      throw new Error("Invalid asset byteLength");
    const resource = relativePath(a.path, "asset path");
    if (assetIds.has(assetId)) throw new Error(`Duplicate assetId: ${assetId}`);
    assetIds.add(assetId);
    const file = fileMap.get(resolveResource(resource));
    if (!file) throw new Error(`Missing asset file: ${resource}`);
    if (a.byteLength !== undefined && a.byteLength !== file.size)
      throw new Error(`Asset byteLength mismatch: ${resource}`);
    assets.push({ ...a, assetId, path: resource } as Asset);
  }
  let nodeCount = 0;
  const sceneIds = new Set<string>();
  const scenes: Scene[] = [];
  const checkReferences = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (
        ["assetId", "svgAssetId", "fallbackAssetId"].includes(key) &&
        typeof item === "string" &&
        !assetIds.has(item)
      )
        throw new Error(`Unresolved asset reference: ${item}`);
      checkReferences(item);
    }
  };
  for (let index = 0; index < raw.scenes.length; index++) {
    const scene = record(raw.scenes[index], "scene");
    const sceneId = nonempty(scene.sceneId, "sceneId");
    nonempty(scene.name, "scene name");
    if (sceneIds.has(sceneId)) throw new Error(`Duplicate sceneId: ${sceneId}`);
    sceneIds.add(sceneId);
    if (scene.index !== index)
      throw new Error(
        `Scene ${sceneId} index must equal its array position ${index}`,
      );
    for (const dimension of ["width", "height"])
      if (
        typeof scene[dimension] !== "number" ||
        !Number.isFinite(scene[dimension]) ||
        (scene[dimension] as number) <= 0
      )
        throw new Error(`Invalid ${dimension} in ${sceneId}`);
    const nodeIds = new Set<string>();
    const walk = (input: unknown, parentId?: string): void => {
      const node = record(input, "node");
      const id = nonempty(node.figmaNodeId, "figmaNodeId");
      if (nodeIds.has(id))
        throw new Error(`Duplicate figmaNodeId in ${sceneId}: ${id}`);
      nodeIds.add(id);
      nodeCount++;
      if (parentId !== undefined && node.parentId !== parentId)
        throw new Error(`Invalid parentId for ${id}`);
      if (!Array.isArray(node.children))
        throw new Error(`Missing children[] for ${id}`);
      node.children.forEach((child) => walk(child, id));
    };
    walk(scene);
    checkReferences(scene);
    if (scene.preview !== undefined) {
      const preview = relativePath(scene.preview, "preview path");
      if (!fileMap.has(resolveResource(preview)))
        throw new Error(`Missing preview: ${preview}`);
    }
    scenes.push(scene as unknown as Scene);
  }
  const warnings: string[] = scenes
    .filter((s) => !s.preview)
    .map((s) => `${s.name}: preview is absent; visual comparison unavailable`);
  if (fileMap.has(reportRelative)) {
    const report = record(
      await verifiedJson(reportRelative),
      "export-report.json",
    );
    if (typeof report.errorCount === "number" && report.errorCount > 0)
      warnings.push(
        `Figma exporter reported ${report.errorCount} errors; inspect source/export-report.json.`,
      );
  } else
    warnings.push(
      "export-report.json is absent; an empty provenance report will be created during import.",
    );
  const missing = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "assetStatus" && item === "missing")
        warnings.push(
          "Source contains an unavailable original asset; a fallback may be present.",
        );
      if (key === "serializationError")
        warnings.push(`Partially serialized source node: ${String(item)}`);
      missing(item);
    }
  };
  missing(scenes);
  const result: SourceInspection = {
    document: {
      ...raw,
      schemaVersion: "1.0.0",
      assets,
      scenes,
    } as SceneDocument,
    files,
    fingerprint: fingerprint(files),
    warnings: [...new Set(warnings)],
    nodeCount,
  };
  if (parsedCache.size >= 8)
    parsedCache.delete(parsedCache.keys().next().value!);
  parsedCache.set(cacheKey, structuredClone(result));
  return result;
}
