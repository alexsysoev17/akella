import { rethrowAbort } from "./errors";
import { AssetRegistry, type FileSink } from "./assets";
import { readNode } from "./nodes";
import { safeId, serialize } from "./serialization";
import type { MotionProject, Report, Scene } from "../types/scene";
export function newReport(): Report {
  return {
    exportedAt: new Date().toISOString(),
    frames: 0,
    nodes: 0,
    images: 0,
    svg: 0,
    warningCount: 0,
    errorCount: 0,
    warnings: [],
    errors: [],
    unsupportedProperties: [],
    fallbackExports: [],
    limitations: [
      "Font files are not bundled; renderer must supply matching fonts.",
      "SVG fidelity is defined by Figma export; masks/clips/outlined strokes may prevent Trim Paths.",
      "Variables/styles are preserved as IDs plus resolved property values; style/variable definitions are not bundled.",
      "Video/GIF playback, prototyping interactions, and component semantics are not reconstructed.",
      "ZIP generation requires memory proportional to project size; export smaller selections for large files.",
    ],
  };
}
export async function exportProject(
  frames: readonly FrameNode[],
  sink: FileSink,
  progress: (done: number, total: number, label: string) => void,
): Promise<Report> {
  if (!frames.length) throw new Error("Select at least one Frame");
  const sourcePage = {
    pageName: figma.currentPage.name,
    pageId: figma.currentPage.id,
  };
  const report = newReport();
  report.frames = frames.length;
  const registry = new AssetRegistry(sink);
  const total = countNodes(frames);
  let done = 0;
  const scenes: Scene[] = [];
  if (
    frames.some(
      (f) => f.width !== frames[0].width || f.height !== frames[0].height,
    )
  )
    report.warnings.push({
      code: "DIFFERENT_SCENE_SIZES",
      message:
        "Scene sizes differ; original dimensions retained. Canvas uses first scene dimensions.",
    });
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    const ctx = {
      registry,
      report,
      rootTransform: frame.absoluteTransform,
      tick: () => progress(++done, total, frame.name),
    };
    const node = await readNode(frame, frame.parent?.id ?? null, index, ctx);
    const scene: Scene = {
      ...node,
      sceneId: `scene_${safeId(frame.id)}`,
      index,
      width: frame.width,
      height: frame.height,
      fills: node.properties.fills ?? [],
      background: node.properties.backgrounds ?? node.properties.fills ?? [],
      opacity: frame.opacity,
      clipsContent: frame.clipsContent,
      transform: frame.relativeTransform,
    };
    try {
      const bytes = await frame.exportAsync({
        format: "PNG",
        constraint: { type: "SCALE", value: 1 },
      });
      const path = `previews/frame_${safeId(frame.id)}.png`;
      await sink(path, bytes);
      scene.preview = path;
    } catch (error) {
      rethrowAbort(error);
      report.errors.push({
        code: "PREVIEW_FAILED",
        message: String(error),
        figmaNodeId: frame.id,
      });
    }
    scenes.push(scene);
  }
  report.images = registry.assets.filter((a) => a.kind === "image").length;
  report.svg = registry.assets.filter((a) => a.kind === "svg").length;
  report.warningCount =
    report.warnings.length + report.unsupportedProperties.length;
  report.errorCount = report.errors.length;
  const project: MotionProject = {
    schemaVersion: "1.0.0",
    source: {
      application: "Figma",
      ...sourcePage,
    },
    canvas: {
      width: frames[0].width,
      height: frames[0].height,
      sizing: "first-scene",
    },
    assets: registry.assets,
    scenes,
  };
  await sink("scene.json", serialize(project));
  await sink("export-report.json", serialize(report));
  return report;
}
export function countNodes(nodes: readonly SceneNode[]): number {
  let count = 0;
  const stack = [...nodes];
  while (stack.length) {
    const node = stack.pop()!;
    count++;
    if ("children" in node) stack.push(...node.children);
  }
  return count;
}
