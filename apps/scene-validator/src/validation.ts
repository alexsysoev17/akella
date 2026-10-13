import { comparePngs } from "./comparison.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile, cp } from "node:fs/promises";
import path from "node:path";
import {
  atomicJson,
  exists,
  fingerprint,
  inventory,
  lockProject,
  noSymlinkPath,
  within,
} from "./files.js";
import { loadProject, readProject } from "./project.js";
import { reconstructProject, sceneFileId } from "./renderer.js";
import { reportHtml } from "./viewer.js";
export { reportHtml } from "./viewer.js";
import type { LoadedProject, ValidationReport } from "./types.js";
export async function validateProject(
  projectPath: string,
  options: { reconstruct?: boolean } = {},
): Promise<ValidationReport> {
  const root = path.resolve(projectPath);
  await noSymlinkPath(root, root);
  const unlock = await lockProject(root);
  let staging: string | undefined;
  try {
    const project = await readProject(root);
    const report: ValidationReport = {
      schemaVersion: "1.0.0",
      projectId: project.config.projectId,
      projectName: project.config.name,
      runId: randomUUID(),
      validatedAt: new Date().toISOString(),
      mode: options.reconstruct ? "reconstruction" : "structural",
      status: "passed",
      reconstruction: "not-requested",
      visualComparison: "not-performed",
      sceneCount: 0,
      assetCount: 0,
      nodeCount: 0,
      scenes: [],
      errors: [],
      warnings: [],
    };
    let beforeFingerprint: string | undefined;
    let loadedProject: LoadedProject | undefined;
    try {
      const loaded = await loadProject(project.root);
      loadedProject = loaded;
      const { inspection } = loaded;
      beforeFingerprint = inspection.fingerprint;
      report.sourceFingerprint = inspection.fingerprint;
      report.sceneCount = inspection.document.scenes.length;
      report.assetCount = inspection.document.assets.length;
      report.nodeCount = inspection.nodeCount;
      report.warnings = inspection.warnings;
      report.scenes = inspection.document.scenes.map((scene) => ({
        sceneId: scene.sceneId,
        name: scene.name,
        width: scene.width,
        height: scene.height,
        status: "structurally-valid",
      }));
      const imported = project.config.imports.at(-1)?.sourceFingerprint;
      if (imported && imported !== inspection.fingerprint)
        report.warnings.push(
          "Source differs from last import fingerprint. Source may have been edited outside the application.",
        );
    } catch (error) {
      report.status = "failed";
      report.errors.push(String(error));
    }
    staging = await mkdtemp(path.join(project.root, ".validation-stage-"));
    await mkdir(path.join(staging, "reconstructed"));
    await mkdir(path.join(staging, "differences"));
    report.structuralStatus = report.status;
    if (options.reconstruct && loadedProject && report.status === "passed") {
      try {
        const outputs = await reconstructProject(loadedProject, staging);
        await mkdir(path.join(staging, "references"));
        for (const scene of loadedProject.inspection.document.scenes) {
          const output = outputs.get(scene.sceneId)!;
          const item = report.scenes.find((s) => s.sceneId === scene.sceneId)!;
          if (output.error) {
            item.visualStatus = "failed";
            item.errors = [output.error];
            report.status = "failed";
            report.errors.push(`${scene.name}: ${output.error}`);
            continue;
          }
          item.reconstructed = output.png;
          item.structuredNodes = output.stats.structuredNodes;
          item.svgFallbacks = output.stats.svgFallbacks;
          item.rasterFallbacks = output.stats.rasterFallbacks;
          item.warnings = output.stats.warnings;
          report.warnings.push(...output.stats.warnings);
          if (scene.preview) {
            const reference = `references/${sceneFileId(scene.sceneId)}.png`;
            await cp(
              within(path.dirname(loadedProject.scenePath), scene.preview),
              path.join(staging, reference),
            );
            item.reference = reference;
            try {
              const difference = `differences/${sceneFileId(scene.sceneId)}.png`;
              item.comparison = await comparePngs(
                path.join(staging, reference),
                path.join(staging, output.png),
                path.join(staging, difference),
              );
              item.difference = difference;
              item.visualStatus =
                item.comparison.changedPixels === 0
                  ? "identical"
                  : "differences";
              report.visualComparison = "completed";
            } catch (error) {
              item.visualStatus = "failed";
              item.errors = [String(error)];
              report.errors.push(`${scene.name}: comparison: ${String(error)}`);
              report.status = "failed";
            }
          } else {
            item.visualStatus = "unavailable";
            report.warnings.push(
              `${scene.name}: no Figma preview; visual comparison unavailable`,
            );
          }
        }
        report.reconstruction = [...outputs.values()].some(
          (output) => output.error,
        )
          ? "failed"
          : "completed";
      } catch (error) {
        report.status = "failed";
        report.reconstruction = "failed";
        report.errors.push(`Reconstruction: ${String(error)}`);
      }
    }
    await atomicJson(path.join(staging, "report.json"), report);
    await writeFile(path.join(staging, "report.html"), reportHtml(report));
    if (
      beforeFingerprint &&
      beforeFingerprint !== fingerprint(await inventory(project.sourceRoot))
    )
      throw new Error(
        "Source changed during validation; results not published",
      );
    const output = within(project.root, "validation");
    if (await exists(output)) await noSymlinkPath(project.root, output);
    const previous = path.join(
      project.root,
      `.validation-previous-${randomUUID()}`,
    );
    let moved = false;
    if (await exists(output)) {
      await rename(output, previous);
      moved = true;
    }
    try {
      await rename(staging, output);
      staging = undefined;
    } catch (error) {
      if (moved) await rename(previous, output);
      throw error;
    }
    if (moved) await rm(previous, { recursive: true, force: true });
    return report;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await unlock();
  }
}
