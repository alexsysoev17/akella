import { ProjectZip } from "./zip";
import type { MainMessage, UiMessage } from "../types/messages";
import type { FrameSummary } from "../types/scene";
const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const exportButton = element<HTMLButtonElement>("export"),
  progress = element<HTMLProgressElement>("progress"),
  status = element("status"),
  download = element<HTMLAnchorElement>("download");
let frames: FrameSummary[] = [];
let busy = false;
let zip: ProjectZip | undefined;
let file:
  | { path: string; size: number; offset: number; bytes: Uint8Array }
  | undefined;
let totalBytes = 0;
let url: string | undefined;
const MAX_BYTES = 512 * 1024 * 1024;
const send = (message: UiMessage) =>
  parent.postMessage({ pluginMessage: message }, "*");
function render() {
  element("selection").textContent = `Selected Frames: ${frames.length}`;
  const list = element("frames");
  list.replaceChildren();
  frames.forEach((frame, index) => {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.className = "name";
    label.textContent = `${index + 1}. ${frame.name}`;
    const size = document.createElement("span");
    size.className = "size";
    size.textContent = `${frame.width} × ${frame.height}`;
    li.append(label, size);
    for (const [text, delta] of [
      ["↑", -1],
      ["↓", 1],
    ] as const) {
      const button = document.createElement("button");
      button.textContent = text;
      button.title = `Move ${frame.name} ${delta < 0 ? "up" : "down"}`;
      button.disabled =
        busy || index + delta < 0 || index + delta >= frames.length;
      button.onclick = () => {
        [frames[index], frames[index + delta]] = [
          frames[index + delta],
          frames[index],
        ];
        render();
      };
      li.append(button);
    }
    list.append(li);
  });
  exportButton.disabled = busy || !frames.length;
}
exportButton.onclick = () => {
  busy = true;
  status.textContent = "Reading Figma document…";
  progress.value = 0;
  download.hidden = true;
  element("issues").hidden = true;
  render();
  send({ type: "export", ids: frames.map((f) => f.id) });
};
window.onmessage = async (
  event: MessageEvent<{ pluginMessage?: MainMessage }>,
) => {
  // Figma bridges Main messages into the iframe; source is not a reliable
  // parent Window reference. Read the documented pluginMessage envelope.
  const message = event.data?.pluginMessage;
  if (!message) return;
  try {
    switch (message.type) {
      case "selection": {
        const old = new Map(frames.map((f, index) => [f.id, index]));
        const same =
          message.frames.length === frames.length &&
          message.frames.every((f) => old.has(f.id));
        frames = same
          ? [...message.frames].sort((a, b) => old.get(a.id)! - old.get(b.id)!)
          : message.frames;
        element("counts").textContent =
          `Nodes: ${message.counts.nodes} · Images: ${message.counts.images} · Vectors: ${message.counts.vectors} · Text Nodes: ${message.counts.text}`;
        const warnings: string[] = [];
        if (message.ignored)
          warnings.push(`${message.ignored} selected non-frame nodes ignored.`);
        if (
          frames.some(
            (f) => f.width !== frames[0].width || f.height !== frames[0].height,
          )
        )
          warnings.push(
            "Frame sizes differ. Original sizes will be preserved.",
          );
        element("warning").textContent = warnings.join(" ");
        render();
        break;
      }
      case "start":
        zip = new ProjectZip();
        file = undefined;
        totalBytes = 0;
        break;
      case "file-start":
        if (!zip || file) throw new Error("Invalid file transfer sequence");
        if (
          !Number.isSafeInteger(message.size) ||
          message.size < 0 ||
          totalBytes + message.size > MAX_BYTES
        )
          throw new Error(
            "Export exceeds 512 MiB safety limit. Select fewer frames.",
          );
        totalBytes += message.size;
        file = {
          path: message.path,
          size: message.size,
          offset: 0,
          bytes: new Uint8Array(message.size),
        };
        break;
      case "file-chunk": {
        if (!file) throw new Error("Chunk received without file");
        const bytes = new Uint8Array(message.bytes);
        if (file.offset + bytes.length > file.size)
          throw new Error("File transfer size mismatch");
        file.bytes.set(bytes, file.offset);
        file.offset += bytes.length;
        send({ type: "ack", sequence: message.sequence });
        break;
      }
      case "file-end":
        if (!file || file.offset !== file.size || !zip)
          throw new Error("Incomplete file transfer");
        zip.add(file.path, file.bytes);
        file = undefined;
        break;
      case "progress":
        progress.value = (message.done / message.total) * 70;
        status.textContent = `Reading ${message.label}: ${message.done}/${message.total} nodes`;
        break;
      case "complete": {
        if (!zip || file) throw new Error("Archive transfer incomplete");
        status.textContent = "Packaging ZIP…";
        const blob = await zip.generate((percent) => {
          progress.value = 70 + percent * 0.3;
        });
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(blob);
        download.href = url;
        download.hidden = false;
        download.click();
        const report = message.report;
        status.textContent = report.errorCount
          ? `ZIP ready with ${report.errorCount} errors and ${report.warningCount} warnings. Some resources are missing; inspect report.`
          : `Exported: ${report.frames} scenes, ${report.nodes} nodes, ${report.images} images, ${report.svg} vectors. ${report.warningCount} warnings.`;
        element("report").textContent = JSON.stringify(report, null, 2);
        element("issues").hidden = false;
        progress.value = 100;
        zip = undefined;
        busy = false;
        render();
        send({ type: "packaged" });
        break;
      }
      case "error":
        status.textContent = message.message;
        file = undefined;
        zip = undefined;
        busy = false;
        render();
        break;
    }
  } catch (error) {
    status.textContent = String(error);
    file = undefined;
    zip = undefined;
    render();
    send({ type: "package-error", message: String(error) });
  }
};
send({ type: "ready" });
