import type { Json, Report } from "../types/scene";
import { toJson } from "./serialization";
import { exportPaints } from "./images";
import { AssetRegistry } from "./assets";
export async function exportText(
  node: TextNode,
  registry: AssetRegistry,
  report: Report,
): Promise<Record<string, Json>> {
  const fields = [
    "fontName",
    "fontSize",
    "fontWeight",
    "lineHeight",
    "letterSpacing",
    "textCase",
    "textDecoration",
    "fills",
    "textStyleId",
    "fillStyleId",
    "listOptions",
    "indentation",
    "hyperlink",
  ] as const;
  const segments = node.getStyledTextSegments([...fields]);
  const serialized: Json[] = [];
  for (const segment of segments) {
    const value = toJson(segment) as Record<string, Json>;
    value.fills = await exportPaints(segment.fills, registry, report, node.id);
    serialized.push(value);
  }
  return {
    characters: node.characters,
    fontName: toJson(node.fontName),
    fontSize: toJson(node.fontSize),
    fontWeight: toJson(node.fontWeight),
    lineHeight: toJson(node.lineHeight),
    letterSpacing: toJson(node.letterSpacing),
    textCase: toJson(node.textCase),
    textDecoration: toJson(node.textDecoration),
    textAlignHorizontal: node.textAlignHorizontal,
    textAlignVertical: node.textAlignVertical,
    textAutoResize: node.textAutoResize,
    paragraphIndent: toJson(node.paragraphIndent),
    paragraphSpacing: toJson(node.paragraphSpacing),
    segments: serialized,
    indexUnits: "UTF-16 code units",
    hasMissingFont: node.hasMissingFont,
  };
}
