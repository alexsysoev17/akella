import type { CanvasKit, CanvasKitInitOptions } from "canvaskit-wasm";
import { createRequire } from "node:module";
import path from "node:path";
let pending: Promise<CanvasKit> | undefined;
/** Official Skia CPU raster surface. No browser, DOM, GPU or OS text APIs. */
export function skia() {
  const init = createRequire(import.meta.url)("canvaskit-wasm") as (
    options: CanvasKitInitOptions,
  ) => Promise<CanvasKit>;
  return (pending ??= init({
    locateFile: (file: string) =>
      path.join(
        path.dirname(createRequire(import.meta.url).resolve("canvaskit-wasm")),
        file,
      ),
  }).then((kit) => {
    kit.setDecodeCacheLimitBytes(256 * 1024 * 1024);
    return kit;
  }));
}
export const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
export const list = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.map(record) : [];
export const number = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
export class NativeRenderError extends Error {
  constructor(
    public code: string,
    message: string,
    public targetId?: string,
  ) {
    super(`${code}: ${targetId ? targetId + ": " : ""}${message}`);
  }
}
