import path from "node:path";
import {
  noSymlinkPath,
  readJson,
  record,
  nonempty,
  relativePath,
  within,
} from "./files.js";
import { inspectSource } from "./source.js";
import type { LoadedProject, ProjectConfig } from "./types.js";
export async function readProject(rootInput: string): Promise<{
  root: string;
  config: ProjectConfig;
  sourceRoot: string;
  sceneRelative: string;
  reportRelative: string;
}> {
  const root = path.resolve(rootInput);
  await noSymlinkPath(root, within(root, "project.json"));
  const raw = record(
    await readJson(path.join(root, "project.json")),
    "project.json",
  );
  if (raw.schemaVersion !== "1.0.0")
    throw new Error("Unsupported project schemaVersion");
  nonempty(raw.projectId, "projectId");
  nonempty(raw.name, "project name");
  const source = record(raw.source, "project.source");
  const scene = relativePath(source.scene, "source.scene");
  const exportReport = relativePath(source.exportReport, "source.exportReport");
  if (!scene.startsWith("source/") || !exportReport.startsWith("source/"))
    throw new Error("Source paths must be inside source/");
  const validation = record(raw.validation, "project.validation");
  if (validation.directory !== "validation")
    throw new Error(
      "Validation output must be validation/ to isolate source and user data",
    );
  if (!Array.isArray(raw.imports))
    throw new Error("project.imports must be an array");
  const settings = record(raw.settings, "project.settings");
  if (settings.validationMode !== "structural")
    throw new Error("Only structural validation is currently implemented");
  const sourceRoot = within(root, "source");
  await noSymlinkPath(root, sourceRoot);
  return {
    root,
    config: raw as unknown as ProjectConfig,
    sourceRoot,
    sceneRelative: scene.slice(7),
    reportRelative: exportReport.slice(7),
  };
}
export async function loadProject(root: string): Promise<LoadedProject> {
  const project = await readProject(root);
  const inspection = await inspectSource(
    project.sourceRoot,
    project.sceneRelative,
    project.reportRelative,
  );
  return {
    root: project.root,
    config: project.config,
    sourceRoot: project.sourceRoot,
    scenePath: within(project.sourceRoot, project.sceneRelative),
    inspection,
  };
}
