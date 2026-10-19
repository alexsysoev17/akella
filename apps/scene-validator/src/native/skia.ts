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

// Own a premultiplied raster plane explicitly. CanvasKit MakeSurface creates an
// Unpremul surface intended for browser ImageData; native compositing needs Premul.
const surfaces = {
  created: 0,
  disposed: 0,
  live: 0,
  liveBytes: 0,
  peakLiveBytes: 0,
};
export function makeSurface(kit: CanvasKit, width: number, height: number) {
  const bytes = width * height * 4;
  const pixels = kit.Malloc(Uint8Array, bytes);
  let surface;
  try {
    surface = kit.MakeRasterDirectSurface(
      {
        width,
        height,
        colorType: kit.ColorType.RGBA_8888,
        alphaType: kit.AlphaType.Premul,
        colorSpace: kit.ColorSpace.SRGB,
      },
      pixels,
      width * 4,
    );
  } catch (error) {
    kit.Free(pixels);
    throw error;
  }
  if (!surface) {
    kit.Free(pixels);
    throw new NativeRenderError(
      "SURFACE_ALLOCATION_FAILED",
      `${width}x${height}`,
    );
  }
  surface.getCanvas().clear(kit.TRANSPARENT);
  surfaces.created++;
  surfaces.live++;
  surfaces.liveBytes += bytes;
  surfaces.peakLiveBytes = Math.max(surfaces.peakLiveBytes, surfaces.liveBytes);
  const release = surface.delete.bind(surface);
  let released = false;
  surface.dispose = () => {
    if (released) return;
    released = true;
    try {
      release();
    } finally {
      kit.Free(pixels);
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
