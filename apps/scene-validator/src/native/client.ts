import { Worker } from "node:worker_threads";
import type { LoadedProject } from "../types.js";
import type { MotionState } from "../motion/schema.js";
import { nativeDigest, type NativeFrame } from "./renderer.js";
export type RenderedFrame = NativeFrame & {
  cacheHit: boolean;
  resourceReuse?:{renderer:boolean;decodedImages:boolean;fonts:boolean;geometry:boolean};
  previewJobs?:{superseded:number};
  cache: { bytes: number; entries: number; hits: number; misses: number };
  memory: NodeJS.MemoryUsage;
  nativeMemory: {
    created: number;
    disposed: number;
    live: number;
    liveBytes: number;
    peakLiveBytes: number;
    wasmHeapBytes: number | null;
  };
};
let worker: Worker | undefined,
  sequence = 0;
const pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      cleanup: () => void;
    }
  >(),
  opened = new Map<string, Promise<unknown>>();
function runtime() {
  if (worker) return worker;
  worker = new Worker(new URL("./worker-runtime.mjs", import.meta.url));
  const generation = worker;
  worker.unref();
  worker.on("message", (m) => {
    if (worker !== generation) return;
    const task = pending.get(m.id);
    if (!task) return;
    pending.delete(m.id);
    task.cleanup();
    if (m.error)
      task.reject(
        Object.assign(new Error(m.error.message), {
          code: m.error.code,
          stack: m.error.stack,
        }),
      );
    else task.resolve(m.result);
    if (!pending.size) worker?.unref();
  });
  const fail = (error: Error) => {
    if (worker !== generation) return;
    for (const task of pending.values()) {
      task.cleanup();
      task.reject(error);
    }
    pending.clear();
    opened.clear();
    worker = undefined;
  };
  worker.on("error", fail);
  worker.on("exit", (code) => {
    if (code) fail(new Error("Native worker exited " + code));
  });
  return worker;
}
function call(message: Record<string, unknown>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (pending.size >= 64) throw new Error("NATIVE_QUEUE_FULL");
  const w = runtime(),
    id = ++sequence;
  w.ref();
  return new Promise<unknown>((resolve, reject) => {
    const abort = () => {
      pending.delete(id);
      w.postMessage({ kind: "cancel", id });
      reject(new Error("RENDER_CANCELLED"));
      if (!pending.size) w.unref();
    };
    pending.set(id, {
      resolve,
      reject,
      cleanup: () => signal?.removeEventListener("abort", abort),
    });
    signal?.addEventListener("abort", abort, { once: true });
    w.postMessage({ ...message, id });
  });
}
export async function renderNativeFrame(
  project: LoadedProject,
  state: MotionState,
  frame: number,
  options: {
    scale?: number;
    cacheNamespace?:string;
    previewSession?:string;
    previewRequest?:number;
    transparent?: boolean;
    encoding?: "png" | "rgba";
    diagnostics?: boolean;
    coverageProbe?: {focus:{sceneId:string;targetId:string}[];ignore:{sceneId:string;targetId:string}[];roi?:boolean};
    cache?: boolean;
    signal?: AbortSignal;
  } = {},
  reopenAttempts = 0,
): Promise<RenderedFrame> {
  options.signal?.throwIfAborted();
  const key = nativeDigest([
    project.root,
    project.inspection.fingerprint,
    state,
  ]);
  let ready = opened.get(key);
  if (!ready) {
    if (opened.size >= 2) opened.delete(opened.keys().next().value!);
    // Open and first frame are one queued worker transaction: simultaneous
    // thumbnail requests cannot evict a session between opening and drawing it.
    ready = call(
      {
        kind: "render-project",
        key,
        preview:options.previewSession?{session:options.previewSession,sequence:options.previewRequest}:undefined,
        project,
        state,
        frame,
        options: {
          cacheNamespace:options.cacheNamespace,
          scale: options.scale ?? 1,
          transparent: options.transparent ?? false,
          encoding: options.encoding ?? "png",
          cache: options.cache ?? true,
          diagnostics: options.diagnostics ?? false,
          coverageProbe: options.coverageProbe,
        },
      },
      options.signal,
    ).catch((e) => {
      if (opened.get(key) === ready) opened.delete(key);
      throw e;
    });
    opened.set(key, ready);
    const result = await ready;
    if (opened.get(key) === ready) opened.set(key, Promise.resolve(undefined));
    options.signal?.throwIfAborted();
    return result as RenderedFrame;
  }
  try {
    await ready;
  } catch (error) {
    if (
      (error as Error).message === "RENDER_CANCELLED" &&
      !options.signal?.aborted &&
      reopenAttempts < 2
    ) {
      if (opened.get(key) === ready) opened.delete(key);
      return renderNativeFrame(
        project,
        state,
        frame,
        options,
        reopenAttempts + 1,
      );
    }
    throw error;
  }
  options.signal?.throwIfAborted();
  try {
    return (await call(
      {
        kind: "render",
        key,
        preview:options.previewSession?{session:options.previewSession,sequence:options.previewRequest}:undefined,
        frame,
        options: {
          cacheNamespace:options.cacheNamespace,
          scale: options.scale ?? 1,
          transparent: options.transparent ?? false,
          encoding: options.encoding ?? "png",
          cache: options.cache ?? true,
          diagnostics: options.diagnostics ?? false,
          coverageProbe: options.coverageProbe,
        },
      },
      options.signal,
    )) as RenderedFrame;
  } catch (e) {
    if (
      (e as Error).message === "NATIVE_SESSION_EXPIRED" &&
      reopenAttempts < 2
    ) {
      opened.delete(key);
      return renderNativeFrame(
        project,
        state,
        frame,
        options,
        reopenAttempts + 1,
      );
    }
    throw e;
  }
}
export async function clearNativeCache() {
  opened.clear();
  if (worker) await call({ kind: "clear" });
}
export async function closeNativeRenderer() {
  const w = worker;
  worker = undefined;
  opened.clear();
  for (const task of pending.values()) {
    task.cleanup();
    task.reject(new Error("NATIVE_RENDERER_CLOSED"));
  }
  pending.clear();
  await w?.terminate();
}
export function renderingMode() {
  const mode = process.env.AKELLA_RENDERER ?? "native";
  if (mode !== "native" && mode !== "browser-compat")
    throw new Error("AKELLA_RENDERER must be native or browser-compat");
  return mode;
}

export async function compareNativeFrames(a: Uint8Array, b: Uint8Array) {
  return (await call({ kind: "compare", a, b })) as {
    changedPixels: number;
    meanAbsoluteError: number;
    pixels: number;
  };
}

export async function probeNativeText(
  project: LoadedProject,
  state: MotionState,
  targetId: string,
  signal?: AbortSignal,
) {
  await renderNativeFrame(project, state, 0, { signal });
  return (await call(
    {
      kind: "probe",
      key: nativeDigest([project.root, project.inspection.fingerprint, state]),
      targetId,
    },
    signal,
  )) as {
    status: string;
    maximumError?: number;
    tolerance?: number;
    reason?: string;
    samples: unknown[];
  };
}

export async function nativeEnvironment() {
  return (await call({ kind: "environment" })) as {
    engine: string;
    fontFilesDigest: string;
  };
}
