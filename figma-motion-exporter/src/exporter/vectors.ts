import { rethrowAbort } from "./errors";
import { AssetRegistry } from "./assets";
import type { Report } from "../types/scene";
import { safeId } from "./serialization";
export const vectorTypes = new Set([
  "RECTANGLE",
  "ELLIPSE",
  "LINE",
  "VECTOR",
  "POLYGON",
  "STAR",
  "BOOLEAN_OPERATION",
]);
export async function exportSvg(
  node: SceneNode,
  registry: AssetRegistry,
  report: Report,
): Promise<string | undefined> {
  if (!("exportAsync" in node)) return undefined;
  try {
    const svg = await node.exportAsync({
      format: "SVG_STRING",
      svgOutlineText: false,
      svgIdAttribute: true,
      svgSimplifyStroke: false,
    });
    const id = `svg_${safeId(node.id)}`;
    await registry.add(
      {
        assetId: id,
        kind: "svg",
        path: `assets/vectors/${id}.svg`,
        mimeType: "image/svg+xml",
        byteLength: utf8Length(svg),
        figmaNodeId: node.id,
      },
      svg,
    );
    report.fallbackExports.push({
      figmaNodeId: node.id,
      assetId: id,
      reason:
        "SVG visual reference; path animation compatibility is not guaranteed",
    });
    return id;
  } catch (error) {
    rethrowAbort(error);
    report.errors.push({
      code: "SVG_EXPORT_FAILED",
      message: String(error),
      figmaNodeId: node.id,
    });
    return undefined;
  }
}
export function utf8Length(text: string): number {
  let length = 0;
  for (const character of text) {
    const cp = character.codePointAt(0)!;
    length += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4;
  }
  return length;
}
