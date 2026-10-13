import JSZip from "jszip";
import type { MotionProject } from "../types/scene";
export const ROOT = "motion-project/";
export function validateProject(
  project: MotionProject,
  paths: ReadonlySet<string>,
): void {
  const ids = new Set<string>();
  for (const asset of project.assets) {
    if (ids.has(asset.assetId))
      throw new Error(`Duplicate asset ID: ${asset.assetId}`);
    ids.add(asset.assetId);
    if (!paths.has(asset.path))
      throw new Error(`Missing asset file: ${asset.path}`);
  }
  for (const scene of project.scenes) {
    if (scene.preview && !paths.has(scene.preview))
      throw new Error(`Missing preview: ${scene.preview}`);
  }
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (
        (key === "assetId" ||
          key === "svgAssetId" ||
          key === "fallbackAssetId") &&
        typeof child === "string" &&
        !ids.has(child)
      )
        throw new Error(`Missing asset reference: ${child}`);
      visit(child);
    }
  };
  visit(project.scenes);
}
export class ProjectZip {
  private zip = new JSZip();
  readonly paths = new Set<string>();
  private project?: MotionProject;
  add(path: string, bytes: Uint8Array): void {
    if (
      path.startsWith("/") ||
      path.includes("..") ||
      path.includes("\\") ||
      !/^[a-zA-Z0-9_./-]+$/.test(path)
    )
      throw new Error("Unsafe archive path");
    if (this.paths.has(path))
      throw new Error(`Duplicate archive path: ${path}`);
    this.paths.add(path);
    this.zip.file(ROOT + path, bytes, {
      date: new Date("1980-01-01T00:00:00Z"),
    });
    if (path === "scene.json")
      this.project = JSON.parse(
        new TextDecoder().decode(bytes),
      ) as MotionProject;
  }
  async generate(progress: (percent: number) => void): Promise<Blob> {
    if (!this.project || !this.paths.has("export-report.json"))
      throw new Error("Project metadata missing");
    validateProject(this.project, this.paths);
    return this.zip.generateAsync(
      { type: "blob", compression: "STORE", streamFiles: true },
      (metadata) => progress(metadata.percent),
    );
  }
}
