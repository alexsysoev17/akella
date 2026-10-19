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

// MakeSurface allocates a caller-owned WASM pixel plane. Surface.delete() alone
// does NOT release it; CanvasKit's software Surface.dispose() does both jobs.
const surfaces = {
  created: 0,
  disposed: 0,
  live: 0,
  liveBytes: 0,
  peakLiveBytes: 0,
};
export function makeSurface(kit: CanvasKit, width: number, height: number) {
  const surface = kit.MakeSurface(width, height);
  if (!surface)
    throw new NativeRenderError(
      "SURFACE_ALLOCATION_FAILED",
      `${width}x${height}`,
    );
  const bytes = width * height * 4;
  surfaces.created++;
  surfaces.live++;
  surfaces.liveBytes += bytes;
  surfaces.peakLiveBytes = Math.max(surfaces.peakLiveBytes, surfaces.liveBytes);
  const release = surface.dispose.bind(surface);
  let released = false;
  surface.dispose = () => {
    if (released) return;
    released = true;
    try {
      release();
    } finally {
      surfaces.disposed++;
      surfaces.live--;
      surfaces.liveBytes -= bytes;
    }
  };
  return surface;
}
export function nativeMemory(kit: CanvasKit) {
  return {
    ...surfaces,
    wasmHeapBytes:
      (kit as unknown as { HEAPU8?: Uint8Array }).HEAPU8?.buffer.byteLength ??
      null,
  };
}
