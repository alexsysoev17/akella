import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { loadProject } from "./project.js";
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
  const { projects } = await discoverProjects(root);
  const project = projects.find((p) => p.config.projectId === id);
  if (!project) throw new Error("Project not found");
  return project;
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
