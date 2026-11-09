export interface ProjectConfig {
  figmaSource?: FigmaSourceLink;
  schemaVersion: "1.0.0";
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  source: { scene: string; exportReport: string };
  validation: { directory: "validation" };
  settings: { validationMode: "structural" };
  imports: {
    importId: string;
    importedAt: string;
    sourceFingerprint: string;
    files: number;
  }[];
}
/** Provenance only. Credentials and temporary asset URLs never belong here. */
export interface FigmaSourceLink {
  version: 1;
  fileKey: string;
  fileUrl: string;
  pageId: string;
  pageName: string;
  sectionId: string;
  sectionName: string;
  frameIds: string[];
  capturedAt: string;
  transport: "figma-mcp";
}
export interface Asset {
  assetId: string;
  path: string;
  byteLength?: number;
  kind?: string;
}
export interface Scene {
  sceneId: string;
  figmaNodeId: string;
  name: string;
  index: number;
  width: number;
  height: number;
  children: unknown[];
  preview?: string;
  [key: string]: unknown;
}
export interface SceneDocument {
  schemaVersion: string;
  assets: Asset[];
  scenes: Scene[];
  [key: string]: unknown;
}
export interface FileDigest {
  path: string;
  size: number;
  sha256: string;
}
export interface SourceInspection {
  document: SceneDocument;
  files: FileDigest[];
  fingerprint: string;
  warnings: string[];
  nodeCount: number;
}
export interface LoadedProject {
  root: string;
  config: ProjectConfig;
  scenePath: string;
  sourceRoot: string;
  inspection: SourceInspection;
}
export interface ValidationReport {
  schemaVersion: "1.0.0";
  projectId: string;
  projectName: string;
  runId: string;
  validatedAt: string;
  mode: "structural" | "reconstruction";
  structuralStatus?: "passed" | "failed";
  status: "passed" | "failed";
  reconstruction: "not-requested" | "completed" | "failed";
  visualComparison: "not-performed" | "completed";
  sceneCount: number;
  assetCount: number;
  nodeCount: number;
  sourceFingerprint?: string;
  scenes: {
    sceneId: string;
    name: string;
    width: number;
    height: number;
    status: "structurally-valid";
    visualStatus?: "identical" | "differences" | "unavailable" | "failed";
    errors?: string[];
    warnings?: string[];
    difference?: string;
    comparison?: {
      changedPixels: number;
      totalPixels: number;
      changedPercent: number;
      meanAbsoluteError: number;
      threshold: number;
    };
    reconstructed?: string;
    reference?: string;
    structuredNodes?: number;
    svgFallbacks?: string[];
    rasterFallbacks?: string[];
  }[];
  errors: string[];
  warnings: string[];
}
