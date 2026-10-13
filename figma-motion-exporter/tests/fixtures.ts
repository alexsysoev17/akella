import { identity, multiply } from "../src/exporter/transforms";
import type { Matrix } from "../src/types/scene";
export const png = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
    "base64",
  ),
);
export const jpeg = new Uint8Array([255, 216, 255, 224, 0, 0, 255, 217]);
export interface Fixture {
  id: string;
  name: string;
  type: string;
  parent: { id: string } | null;
  width: number;
  height: number;
  absoluteTransform: Matrix;
  relativeTransform: Matrix;
  children?: Fixture[];
  [key: string]: unknown;
}
export function node(
  type: string,
  id: string,
  extra: Record<string, unknown> = {},
): Fixture {
  const transform =
    (extra.relativeTransform as Matrix | undefined) ?? identity();
  return {
    id,
    name: id,
    type,
    parent: null,
    x: transform[0][2],
    y: transform[1][2],
    width: 100,
    height: 100,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: "NORMAL",
    relativeTransform: transform,
    absoluteTransform: transform,
    fills: [],
    strokes: [],
    effects: [],
    exportAsync: async (settings: ExportSettings | ExportSettingsSVGString) =>
      settings.format === "SVG_STRING"
        ? '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L10 10"/></svg>'
        : png,
    ...extra,
  };
}
export function frame(
  id: string,
  children: Fixture[] = [],
  extra: Record<string, unknown> = {},
): Fixture {
  const result = node("FRAME", id, { children, clipsContent: true, ...extra });
  function bind(parent: Fixture) {
    for (const child of parent.children ?? []) {
      child.parent = { id: parent.id };
      child.absoluteTransform = multiply(
        parent.absoluteTransform,
        child.relativeTransform,
      );
      bind(child);
    }
  }
  bind(result);
  return result;
}
export function asFrames(...fixtures: Fixture[]): FrameNode[] {
  return fixtures as unknown as FrameNode[];
}
export function installFigma(images: Record<string, Uint8Array> = {}): {
  reads: () => number;
} {
  let reads = 0;
  Object.defineProperty(globalThis, "figma", {
    configurable: true,
    value: {
      currentPage: { id: "page:1", name: "Page 1" },
      getImageByHash: (hash: string) =>
        images[hash]
          ? {
              getBytesAsync: async () => {
                reads++;
                return images[hash];
              },
            }
          : null,
    },
  });
  return { reads: () => reads };
}
export const imagePaint = {
  type: "IMAGE",
  scaleMode: "CROP",
  imageHash: "sameHash",
  imageTransform: [
    [0.5, 0, 0.2],
    [0, 0.5, 0.1],
  ],
  opacity: 0.8,
  rotation: 0,
  filters: { contrast: 0.1 },
};
