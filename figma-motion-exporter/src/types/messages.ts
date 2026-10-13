import type { FrameSummary, Report } from "./scene";
export type UiMessage =
  | { type: "ready" }
  | { type: "export"; ids: string[] }
  | { type: "ack"; sequence: number }
  | { type: "packaged" }
  | { type: "package-error"; message: string };
export type MainMessage =
  | {
      type: "selection";
      frames: FrameSummary[];
      counts: { nodes: number; images: number; vectors: number; text: number };
      ignored: number;
    }
  | { type: "start" }
  | { type: "file-start"; path: string; size: number }
  | { type: "file-chunk"; sequence: number; bytes: Uint8Array }
  | { type: "file-end" }
  | { type: "progress"; done: number; total: number; label: string }
  | { type: "complete"; report: Report }
  | { type: "error"; message: string };
