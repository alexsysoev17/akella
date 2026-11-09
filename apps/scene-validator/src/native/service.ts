import {previewProtocolVersion,renderDimensions} from "./quality.js";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { LoadedProject } from "../types.js";
import { readMotion, type MotionDocument } from "../motion/store.js";
import { renderNativeFrame } from "./client.js";
const snapshots = new Map<string, { stamp: string; doc: MotionDocument }>();
export async function renderProjectFrame(
  project: LoadedProject,
  frame: number,
  options: {
    scale?: number;
    previewSession?:string;
    previewRequest?:number;
    transparent?: boolean;
    encoding?: "png" | "rgba";
    diagnostics?: boolean;
    signal?: AbortSignal;
    revision?: string;
  } = {},
) {
  const file = path.join(project.root, "motion/motion.json");
  let stamp = project.inspection.fingerprint;
  try {
    const s = await stat(file);
    stamp += `:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  let saved = snapshots.get(project.root);
  if (!saved || saved.stamp !== stamp) {
    saved = { stamp, doc: await readMotion(project) };
    if (snapshots.size >= 8) snapshots.delete(snapshots.keys().next().value!);
    snapshots.set(project.root, saved);
  }
  if (options.revision && options.revision !== saved.doc.revision)
    throw new Error("STALE_PROJECT_REVISION");
  if (!Number.isSafeInteger(frame) || frame < 0 || frame >= saved.doc.state.settings.durationFrames) throw new Error("FRAME_OUTSIDE_OUTPUT_WINDOW");
  const rendered = await renderNativeFrame(
    project,
    saved.doc.state,
    frame,
    {...options,cacheNamespace:previewProtocolVersion+':'+saved.doc.revision},
  );
  return {
    ...rendered,
    projectWidth:saved.doc.state.settings.width,projectHeight:saved.doc.state.settings.height,
    previewScale:options.scale??1,
    requestedRenderResolution:renderDimensions(saved.doc.state.settings.width,saved.doc.state.settings.height,options.scale??1),
    rendererVersion:previewProtocolVersion,
    revision: saved.doc.revision,
    sourceFingerprint: project.inspection.fingerprint,
  };
}
export function framePacket(
  result: Awaited<ReturnType<typeof renderProjectFrame>>,
) {
  const { png, ...metadata } = result,
    json = Buffer.from(JSON.stringify(metadata)),
    head = Buffer.alloc(4);
  head.writeUInt32BE(json.length);
  return Buffer.concat([head, json, png]);
}
