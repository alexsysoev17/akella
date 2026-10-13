import { ExportAbortedError } from "./exporter/errors";
import { orderFrames } from "./exporter/ordering";
import { countNodes, exportProject } from "./exporter/scene";
import { vectorTypes } from "./exporter/vectors";
import type { MainMessage, UiMessage } from "./types/messages";
figma.showUI(__html__, { width: 420, height: 580, themeColors: true });
figma.skipInvisibleInstanceChildren = false;
let busy = false;
let sequence = 0;
let transferError: Error | undefined;
let reading = false;
let pending:
  | {
      sequence: number;
      resolve: () => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  | undefined;
const send = (message: MainMessage) => figma.ui.postMessage(message);
function selected(): FrameNode[] {
  return figma.currentPage.selection.filter(
    (node): node is FrameNode => node.type === "FRAME",
  );
}
function updateSelection() {
  if (busy) return;
  const frames = selected();
  const hashes = new Set<string>();
  let vectors = 0,
    text = 0;
  const stack: SceneNode[] = [...frames];
  while (stack.length) {
    const n = stack.pop()!;
    if (vectorTypes.has(n.type)) vectors++;
    if (n.type === "TEXT") {
      text++;
      for (const s of n.getStyledTextSegments(["fills"]))
        for (const p of s.fills)
          if (p.type === "IMAGE" && p.imageHash) hashes.add(p.imageHash);
    }
    for (const key of ["fills", "strokes", "backgrounds"] as const) {
      if (key in n) {
        const value = (n as unknown as Record<string, unknown>)[key];
        if (Array.isArray(value))
          for (const p of value as Paint[])
            if (p.type === "IMAGE" && p.imageHash) hashes.add(p.imageHash);
      }
    }
    if ("children" in n) stack.push(...n.children);
  }
  send({
    type: "selection",
    frames: orderFrames(
      frames.map((f) => ({
        id: f.id,
        name: f.name,
        width: f.width,
        height: f.height,
        x: f.absoluteTransform[0][2],
        y: f.absoluteTransform[1][2],
      })),
    ),
    counts: { nodes: countNodes(frames), images: hashes.size, vectors, text },
    ignored: figma.currentPage.selection.length - frames.length,
  });
}
async function sink(path: string, data: Uint8Array | string) {
  if (transferError) throw transferError;
  // Strings (SVG/JSON) are sent separately through the same binary protocol.
  const bytes = typeof data === "string" ? utf8(data) : data;
  send({ type: "file-start", path, size: bytes.length });
  for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
    const id = ++sequence;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending = undefined;
        transferError = new ExportAbortedError(
          "UI transfer timeout. Export stopped to avoid missing files.",
        );
        reject(transferError);
      }, 30000);
      pending = { sequence: id, resolve, reject, timer };
      send({
        type: "file-chunk",
        sequence: id,
        bytes: bytes.slice(offset, offset + 256 * 1024),
      });
    });
  }
  send({ type: "file-end" });
}
function utf8(value: string): Uint8Array {
  const bytes: number[] = [];
  for (const character of value) {
    const cp = character.codePointAt(0)!;
    if (cp < 128) bytes.push(cp);
    else if (cp < 2048) bytes.push(192 | (cp >> 6), 128 | (cp & 63));
    else if (cp < 65536)
      bytes.push(224 | (cp >> 12), 128 | ((cp >> 6) & 63), 128 | (cp & 63));
    else
      bytes.push(
        240 | (cp >> 18),
        128 | ((cp >> 12) & 63),
        128 | ((cp >> 6) & 63),
        128 | (cp & 63),
      );
  }
  return new Uint8Array(bytes);
}
figma.on("selectionchange", () => {
  try {
    updateSelection();
  } catch (error) {
    send({ type: "error", message: String(error) });
  }
});
figma.ui.onmessage = async (message: UiMessage) => {
  if (message.type === "ack" && pending?.sequence === message.sequence) {
    clearTimeout(pending.timer);
    pending.resolve();
    pending = undefined;
    return;
  }
  if (message.type === "ready") {
    try {
      updateSelection();
    } catch (error) {
      send({ type: "error", message: String(error) });
    }
    return;
  }
  if (message.type === "package-error") {
    transferError = new ExportAbortedError(message.message);
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(transferError);
      pending = undefined;
    }
    if (!reading) {
      busy = false;
      send({ type: "error", message: message.message });
      updateSelection();
    }
    return;
  }
  if (message.type === "packaged") {
    busy = false;
    updateSelection();
    return;
  }
  if (message.type !== "export" || busy) return;
  busy = true;
  reading = true;
  transferError = undefined;
  try {
    const frames = selected();
    const map = new Map(frames.map((f) => [f.id, f]));
    if (
      !message.ids.length ||
      new Set(message.ids).size !== message.ids.length ||
      message.ids.length !== frames.length
    )
      throw new Error("Selection changed. Refresh selection and retry.");
    const ordered = message.ids.map((id) => {
      const frame = map.get(id);
      if (!frame)
        throw new Error("Selection changed. Refresh selection and retry.");
      return frame;
    });
    send({ type: "start" });
    const report = await exportProject(ordered, sink, (done, total, label) =>
      send({ type: "progress", done, total, label }),
    );
    reading = false;
    send({ type: "complete", report });
  } catch (error) {
    reading = false;
    busy = false;
    send({ type: "error", message: String(error) });
    updateSelection();
  }
};
