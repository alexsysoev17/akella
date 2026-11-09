import type { FigmaSourceLink, SceneDocument } from "./types.js";

export function assertFigmaSource(link: FigmaSourceLink, document: SceneDocument): void {
  if (link.version !== 1 || link.transport !== "figma-mcp" ||
      !/^[a-zA-Z0-9]+$/.test(link.fileKey) ||
      !/^\d+:\d+$/.test(link.pageId) || !/^\d+:\d+$/.test(link.sectionId) ||
      !Array.isArray(link.frameIds) || !link.frameIds.length ||
      link.frameIds.some(id => !/^\d+:\d+$/.test(id)) ||
      new Set(link.frameIds).size !== link.frameIds.length ||
      !Number.isFinite(Date.parse(link.capturedAt))) throw new Error("Invalid Figma source link");
  if (link.fileUrl !== `https://www.figma.com/design/${link.fileKey}?node-id=${link.sectionId.replace(":", "-")}`)
    throw new Error("Figma source URL does not match identity");
  const source = document.source as { pageId?: string; pageName?: string } | undefined;
  if (source?.pageId !== link.pageId || source.pageName !== link.pageName ||
      JSON.stringify(document.scenes.map(s => s.figmaNodeId)) !== JSON.stringify(link.frameIds))
    throw new Error("Figma provenance does not match exported page/frames");
}

function identities(doc: SceneDocument): Map<string, string> {
  const result = new Map<string, string>();
  const visit = (node: any, scene: string) => {
    result.set(`${scene}/${node.figmaNodeId}`, JSON.stringify([node.name, node.type, node.parentId ?? null]));
    for (const child of node.children ?? []) visit(child, scene);
  };
  for (const scene of doc.scenes) visit(scene, scene.sceneId);
  return result;
}

/** Conservative identity check; no geometric/visual judgement and no automatic rebinding. */
export function assertFigmaRefresh(
  previous: FigmaSourceLink | undefined, next: FigmaSourceLink,
  before: SceneDocument, after: SceneDocument,
): void {
  if (previous && (previous.fileKey !== next.fileKey || previous.pageId !== next.pageId ||
      previous.sectionId !== next.sectionId || JSON.stringify(previous.frameIds) !== JSON.stringify(next.frameIds)))
    throw new Error("Figma source selection changed; explicit migration required");
  if (JSON.stringify(before.scenes.map(s => s.sceneId)) !== JSON.stringify(after.scenes.map(s => s.sceneId)))
    throw new Error("Figma frame identity/order changed; explicit migration required");
  const a = identities(before), b = identities(after);
  const changed = [...a].filter(([key, value]) => b.get(key) !== value).map(([key]) => key);
  if (changed.length) throw new Error(`Figma layer identity/name/parent changed; review required: ${changed.join(", ")}`);
}
