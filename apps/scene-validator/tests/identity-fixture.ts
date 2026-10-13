import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createProject } from "../src/importer.js";
import { loadProject } from "../src/project.js";
import { defaultMotion } from "../src/motion/context.js";
import { logicalId } from "../src/motion/registry.js";
import type { SourceNode } from "../src/motion/registry.js";
import type { ObjectTransition } from "../src/motion/schema.js";
export function node(
  id: string,
  name: string,
  x = 0,
  y = 0,
  w = 20,
  h = 20,
  children: SourceNode[] = [],
): SourceNode {
  return {
    figmaNodeId: id,
    name,
    type: "RECTANGLE",
    parentId: undefined,
    sceneTransform: [
      [1, 0, x],
      [0, 1, y],
    ],
    properties: {
      width: w,
      height: h,
      fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }],
    },
    children,
  };
}
export async function identityFixture(
  count = 3,
  edit?: (scenes: ReturnType<typeof scenesFixture>) => void,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "identity-test-")),
    source = path.join(root, "export");
  await mkdir(path.join(source, "assets"), { recursive: true });
  await writeFile(
    path.join(source, "assets/qr.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path d="M0 0h20v20H0z" fill="black"/><path d="M4 4h12v12H4z" fill="white"/><path d="M8 8h4v4H8z" fill="black"/></svg>',
  );
  const scenes = scenesFixture(count);
  edit?.(scenes);
  const parents = (n: SourceNode) =>
    n.children.forEach((c) => {
      c.parentId = n.figmaNodeId;
      parents(c);
    });
  scenes.forEach((s) => parents(s as unknown as SourceNode));
  await writeFile(
    path.join(source, "scene.json"),
    JSON.stringify({
      schemaVersion: "1.0.0",
      assets: [{ assetId: "qr-svg", path: "assets/qr.svg", kind: "vector" }],
      scenes,
    }),
  );
  await writeFile(path.join(source, "export-report.json"), '{"errorCount":0}');
  const imported = await createProject({
    source,
    name: "Identity fixture",
    projectsRoot: path.join(root, "projects"),
  });
  const project = await loadProject(imported.projectPath),
    state = defaultMotion(project);
  state.settings = { ...state.settings, fps: 12, durationFrames: count * 12 };
  state.blocks.forEach((b, i) => {
    b.startFrame = i * 12;
    b.durationFrames = 12;
  });
  const transition: ObjectTransition = {
    transitionId: "qr-move",
    logicalObjectId: logicalId("QR"),
    fromSceneId: "s1",
    toSceneId: "s2",
    startFrame: 18,
    durationFrames: 6,
    easing: "easeInOutCubic",
    proceduralEffects: [],
    layerPolicy: { type: "switch", switchProgress: 1 },
  };
  return {
    root,
    source,
    project,
    state,
    transition,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
export function scenesFixture(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const qr = node(
      `qr${i}`,
      "QR",
      i === 1 ? 160 : 70,
      i === 1 ? 80 : 20,
      i === 1 ? 20 : 60,
      i === 1 ? 20 : 60,
    );
    qr.type = "VECTOR";
    qr.svgAssetId = "qr-svg";
    return {
      ...node(`root${i}`, "QR", 0, 0, 200, 120, i === 0 ? [] : [qr]),
      sceneId: `s${i}`,
      index: i,
      width: 200,
      height: 120,
      type: "FRAME",
      properties: {
        width: 200,
        height: 120,
        clipsContent: true,
        fills: [{ type: "SOLID", color: { r: 0, g: 0.8, b: 0.2 } }],
      },
    };
  });
}
