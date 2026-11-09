import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { loadProject, readProject } from "./project.js";
import { noSymlinkPath } from "./files.js";
export async function discoverProjects(root: string) {
  const projects = [],
    errors: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    try {
      const project = await loadProject(path.join(root, entry.name));
      projects.push(project);
    } catch (error) {
      errors.push(`${entry.name}: ${String(error)}`);
    }
  }
  return { projects, errors };
}
export async function findProject(root: string, id: string) {
  // Frame requests must not inspect/hash source assets in every unrelated project.
  // Read small manifests to resolve the folder, then inspect only the selected source.
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const folder = path.join(root, entry.name);
    try {
      const project = await readProject(folder);
      if (project.config.projectId === id) return await loadProject(folder);
    } catch {
      /* Same invalid-project exclusion as discoverProjects. */
    }
  }
  throw new Error("Project not found");
}
export function summary(p: Awaited<ReturnType<typeof loadProject>>) {
  return {
    projectId: p.config.projectId,
    sourceFingerprint: p.inspection.fingerprint,
    name: p.config.name,
    updatedAt: p.config.updatedAt,
    sceneCount: p.inspection.document.scenes.length,
    resolution: [
      ...new Set(
        p.inspection.document.scenes.map((s) => `${s.width}×${s.height}`),
      ),
    ].join(", "),
  };
}
export async function readOptional(root: string, relative: string) {
  try {
    const file = path.join(root, relative);
    await noSymlinkPath(root, file);
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
