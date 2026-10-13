export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type Matrix = [[number, number, number], [number, number, number]];
export interface Asset {
  assetId: string;
  kind: "image" | "svg" | "fallback";
  path: string;
  mimeType: string;
  byteLength: number;
  imageHash?: string;
  figmaNodeId?: string;
}
export interface ExportNode {
  figmaNodeId: string;
  name: string;
  alias: string;
  type: string;
  parentId: string | null;
  layerOrder: number;
  sceneTransform: Matrix;
  origin: { x: 0; y: 0; units: "local-pixels"; description: string };
  properties: Record<string, Json>;
  children: ExportNode[];
  text?: Record<string, Json>;
  svgAssetId?: string;
  fallbackAssetId?: string;
  serializationError?: string;
}
export interface Scene extends ExportNode {
  fills: Json;
  background: Json;
  opacity: number;
  clipsContent: boolean;
  transform: Matrix;
  sceneId: string;
  index: number;
  width: number;
  height: number;
  preview?: string;
}
export interface MotionProject {
  schemaVersion: "1.0.0";
  source: { application: "Figma"; pageName: string; pageId: string };
  canvas: { width: number; height: number; sizing: "first-scene" };
  assets: Asset[];
  scenes: Scene[];
}
export interface Issue {
  code: string;
  message: string;
  figmaNodeId?: string;
  property?: string;
}
export interface Report {
  exportedAt: string;
  frames: number;
  nodes: number;
  images: number;
  svg: number;
  warningCount: number;
  errorCount: number;
  warnings: Issue[];
  errors: Issue[];
  unsupportedProperties: Issue[];
  fallbackExports: { figmaNodeId: string; assetId: string; reason: string }[];
  limitations: string[];
}
export interface FrameSummary {
  id: string;
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
}
