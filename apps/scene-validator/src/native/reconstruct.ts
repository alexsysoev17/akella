import { writeFile, rm } from "node:fs/promises";
import path from "node:path";
import type { LoadedProject } from "../types.js";
import type { RenderStats } from "../renderer.js";
import { defaultMotion } from "../motion/context.js";
import { renderNativeFrame } from "./client.js";
export async function reconstructNativeProject(
  project: LoadedProject,
  output: string,
) {
  const results = new Map<
    string,
    { png: string; html: string; stats: RenderStats; error?: string }
  >();
  for (const scene of project.inspection.document.scenes) {
    const id = Buffer.from(scene.sceneId).toString("hex"),
      png = `reconstructed/${id}.png`,
      html = `reconstructed/${id}.html`;
    const stats: RenderStats = {
      structuredNodes: 0,
      svgFallbacks: [],
      rasterFallbacks: [],
      warnings: [],
      fonts: [],
    };
    try {
      const isolated = {
        ...project,
        inspection: {
          ...project.inspection,
          fingerprint: project.inspection.fingerprint + ":" + scene.sceneId,
          document: { ...project.inspection.document, scenes: [scene] },
        },
      };
      const state = defaultMotion(isolated);
      state.settings.width = Math.ceil(scene.width);
      state.settings.height = Math.ceil(scene.height);
      const rendered = await renderNativeFrame(isolated, state, 0, {
        transparent: true,
      });
      const count = (n: unknown): number => {
        const node = n as { children?: unknown[] };
        return (
          1 +
          (node.children ?? []).reduce<number>((sum, n) => sum + count(n), 0)
        );
      };
      stats.structuredNodes = count(scene);
      stats.warnings = rendered.warnings;
      stats.svgFallbacks = rendered.fallbacks
        .filter((f) => f.format === "SVG")
        .map((f) => f.targetId);
      stats.rasterFallbacks = rendered.fallbacks
        .filter((f) => f.format === "RASTER")
        .map((f) => f.targetId);
      await writeFile(path.join(output, png), rendered.png);
      await writeFile(
        path.join(output, html),
        `<!doctype html><meta charset="utf-8"><title>Skia reconstruction</title><style>body{margin:0}img{max-width:100%}</style><img src="${id}.png" alt="Native Skia reconstruction">`,
      );
      results.set(scene.sceneId, { png, html, stats });
    } catch (e) {
      await Promise.all(
        [png, html].map((f) => rm(path.join(output, f), { force: true })),
      );
      results.set(scene.sceneId, {
        png: "",
        html: "",
        stats,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}
