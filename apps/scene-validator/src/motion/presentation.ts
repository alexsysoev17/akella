import { presentationBlocks } from "./transition-runtime.js";
import { statePresentation, transitionDiagnostics } from "./transitions.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildSceneSvg, escape } from "../renderer.js";
import { within } from "../files.js";
import type { LoadedProject } from "../types.js";
import type { MotionState } from "./schema.js";
import { validateMotion } from "./operations.js";
const cache = new Map<
  string,
  { markup: string; fonts: string; warnings: string[] }
>();
export async function motionHtml(project: LoadedProject, state: MotionState) {
  validateMotion(state, project);
  const parts: string[] = [],
    warnings: string[] = transitionDiagnostics(state, project);
  let fonts = "";
  for (const block of presentationBlocks(state).sort(
    (a, b) => a.startFrame - b.startFrame,
  )) {
    const scene = project.inspection.document.scenes.find(
      (s) => s.sceneId === block.sceneId,
    )!;
    const key =
      project.root + "/" + project.inspection.fingerprint + "/" + scene.sceneId;
    let built = cache.get(key);
    if (!built) {
      const svg = await buildSceneSvg(
        structuredClone(scene),
        project.inspection.document.assets,
        (a) => readFile(within(path.dirname(project.scenePath), a.path)),
        { motion: true },
      );
      built = {
        markup: svg.svg,
        fonts: svg.fontCss,
        warnings: svg.stats.warnings,
      };
      if (cache.size >= 40) cache.clear();
      cache.set(key, built);
    }
    warnings.push(...built.warnings);
    const scale = Math.min(
      state.settings.width / scene.width,
      state.settings.height / scene.height,
    );
    // SVG fragment identifiers are document-global, including across sibling SVG roots.
    const prefix = "b" + Buffer.from(block.blockId).toString("hex") + "-";
    fonts += built.fonts.replace(/motion-font-\d+/g, (alias) => prefix + alias);
    const markup = built.markup
      .replace(/motion-font-\d+/g, (alias) => prefix + alias)
      .replace(/\sid="([^"]+)"/g, (_m, id: string) => ` id="${prefix}${id}"`)
      .replace(/url\(#([^)]+)\)/g, (_m, id: string) => `url(#${prefix}${id})`);
    parts.push(
      `<div data-motion-block="${escape(block.blockId)}" data-motion-scene="${escape(scene.sceneId)}" style="position:absolute;inset:0;display:none"><div style="position:absolute;left:${(state.settings.width - scene.width * scale) / 2}px;top:${(state.settings.height - scene.height * scale) / 2}px;transform:scale(${scale});transform-origin:0 0">${markup}</div></div>`,
    );
  }
  const runtime = await readFile(
    new URL("../web/motion-runtime.js", import.meta.url),
    "utf8",
  );
  const states = JSON.stringify(statePresentation(project, state)).replaceAll(
    "<",
    "\\u003c",
  );
  const json = JSON.stringify(state).replaceAll("<", "\\u003c");
  return {
    warnings: [...new Set(warnings)],
    html: `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#000;overflow:hidden}#canvas{position:relative;width:${state.settings.width}px;height:${state.settings.height}px;transform-origin:0 0}svg{display:block}${fonts}</style></head><body><div id="canvas">${parts.join("")}</div><script id="object-states" type="application/json">${states}</script><script id="motion-state" type="application/json">${json}</script><script>${runtime.replaceAll("</script", "<\\/script")}</script><script>function fit(){document.getElementById('canvas').style.transform='scale('+Math.min(innerWidth/${state.settings.width},innerHeight/${state.settings.height})+')'}addEventListener('resize',fit);fit();</script></body></html>`,
  };
}

/** Static thumbnail rebuilt from structured scene data; never reads Figma previews. */
export async function sceneThumbnailHtml(
  project: LoadedProject,
  sceneId: string,
) {
  const scene = project.inspection.document.scenes.find(
    (s) => s.sceneId === sceneId,
  );
  if (!scene) throw new Error("Сцена не найдена");
  const key =
    project.root +
    "/" +
    project.inspection.fingerprint +
    "/thumbnail/" +
    sceneId;
  let built = cache.get(key);
  if (!built) {
    const svg = await buildSceneSvg(
      structuredClone(scene),
      project.inspection.document.assets,
      (a) => readFile(within(path.dirname(project.scenePath), a.path)),
    );
    built = {
      markup: svg.svg,
      fonts: svg.fontCss,
      warnings: svg.stats.warnings,
    };
    if (cache.size >= 40) cache.clear();
    cache.set(key, built);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#ececef}svg{width:100%;height:100%;display:block}${built.fonts}</style></head><body>${built.markup}</body></html>`;
}
