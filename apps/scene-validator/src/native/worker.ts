import { validateMotion } from "../motion/operations.js";
import { fontCatalogDigest } from "./fonts.js";
import { parentPort } from "node:worker_threads";
import { skia, nativeMemory } from "./skia.js";
import { NativeRenderer, nativeDigest, type NativeFrame } from "./renderer.js";
import type { LoadedProject } from "../types.js";
import type { MotionState } from "../motion/schema.js";
interface Session {
  renderer: NativeRenderer;
  state: MotionState;
  resourceKey: string;
}
const sessions = new Map<string, Session>(),
  cache = new Map<string, NativeFrame>(),
  cancelled = new Set<number>();
let bytes = 0,
  hits = 0,
  misses = 0;
function clear() {
  cache.clear();
  bytes = 0;
}
let queue = Promise.resolve();
parentPort!.on("message", (message) => {
  if (message.kind === "cancel") {
    cancelled.add(message.id);
    if (cancelled.size > 512)
      cancelled.delete(cancelled.values().next().value!);
    return;
  }
  queue = queue.then(async () => {
    const { id, kind } = message;
    try {
      if (cancelled.delete(id)) return;
      if (kind === "open" || kind === "render-project") {
        validateMotion(message.state, message.project);
        if (!sessions.has(message.key)) {
          const resourceKey = nativeDigest([
            message.project.root,
            message.project.inspection.fingerprint,
          ]);
          const reusable = [...sessions.values()].find(
            (s) => s.resourceKey === resourceKey,
          )?.renderer;
          while (sessions.size >= 2) {
            const key = sessions.keys().next().value!,
              old = sessions.get(key)!;
            sessions.delete(key);
            if (
              old.renderer !== reusable &&
              ![...sessions.values()].some((s) => s.renderer === old.renderer)
            )
              old.renderer.dispose();
            clear();
          }
          const renderer =
            reusable ??
            (await NativeRenderer.create(message.project as LoadedProject));
          sessions.set(message.key, {
            renderer,
            state: message.state,
            resourceKey,
          });
        }
        if (kind === "open") {
          parentPort!.postMessage({ id, result: { ready: true } });
          return;
        }
      }
      if (kind === "render" || kind === "render-project") {
        if (cancelled.delete(id)) return;
        const session = sessions.get(message.key);
        if (!session) throw new Error("NATIVE_SESSION_EXPIRED");
        const key =
          message.key +
          ":" +
          message.frame +
          ":" +
          nativeDigest(message.options ?? {});
        let result =
            message.options?.cache === false ? undefined : cache.get(key),
          cacheHit = !!result;
        if (result) {
          hits++;
          cache.delete(key);
          cache.set(key, result);
        } else {
          misses++;
          result = session.renderer.render(
            session.state,
            message.frame,
            message.options,
          );
          while (
            bytes + result.png.byteLength > 64 * 1024 * 1024 ||
            cache.size >= 120
          ) {
            const old = cache.keys().next().value;
            if (!old) break;
            bytes -= cache.get(old)!.png.byteLength;
            cache.delete(old);
          }
          if (
            message.options?.cache !== false &&
            result.png.byteLength <= 64 * 1024 * 1024
          ) {
            cache.set(key, result);
            bytes += result.png.byteLength;
          }
        }
        const png = Uint8Array.from(result.png);
        parentPort!.postMessage(
          {
            id,
            result: {
              ...result,
              png,
              cacheHit,
              cache: { bytes, entries: cache.size, hits, misses },
              memory: process.memoryUsage(),
              nativeMemory: nativeMemory(await skia()),
            },
          },
          [png.buffer],
        );
      } else if (kind === "environment") {
        const digest = await fontCatalogDigest(await skia());
        parentPort!.postMessage({
          id,
          result: { engine: "canvaskit-wasm/0.42.0", fontFilesDigest: digest },
        });
      } else if (kind === "probe") {
        const session = sessions.get(message.key);
        if (!session) throw new Error("NATIVE_SESSION_EXPIRED");
        parentPort!.postMessage({
          id,
          result: session.renderer.probeText(message.targetId),
        });
      } else if (kind === "compare") {
        const kit = await skia(),
          a = kit.MakeImageFromEncoded(message.a),
          b = kit.MakeImageFromEncoded(message.b);
        try {
          if (!a || !b) throw new Error("NATIVE_COMPARE_DECODE_FAILED");
          if (a.width() !== b.width() || a.height() !== b.height())
            throw new Error("NATIVE_COMPARE_SIZE_MISMATCH");
          const info = {
              width: a.width(),
              height: a.height(),
              colorType: kit.ColorType.RGBA_8888,
              alphaType: kit.AlphaType.Unpremul,
              colorSpace: kit.ColorSpace.SRGB,
            },
            x = a.readPixels(0, 0, info)!,
            y = b.readPixels(0, 0, info)!;
          let changed = 0,
            sum = 0;
          for (let i = 0; i < x.length; i += 4) {
            let peak = 0;
            for (let c = 0; c < 4; c++) {
              const d = Math.abs(x[i + c] - y[i + c]);
              sum += d;
              peak = Math.max(peak, d);
            }
            if (peak > 8) changed++;
          }
          parentPort!.postMessage({
            id,
            result: {
              changedPixels: changed,
              meanAbsoluteError: sum / x.length,
              pixels: x.length / 4,
            },
          });
        } finally {
          a?.delete();
          b?.delete();
        }
      } else if (kind === "clear") {
        for (const s of sessions.values()) s.renderer.dispose();
        sessions.clear();
        clear();
        parentPort!.postMessage({ id, result: { cleared: true } });
      } else throw new Error("NATIVE_COMMAND_UNSUPPORTED");
    } catch (error) {
      parentPort!.postMessage({
        id,
        error: {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          code: (error as { code?: string }).code ?? "NATIVE_RENDER_FAILED",
        },
      });
    }
  });
});
