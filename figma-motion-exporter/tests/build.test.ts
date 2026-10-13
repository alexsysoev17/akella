import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import type { MainMessage, UiMessage } from "../src/types/messages";
import { ProjectZip } from "../src/ui/zip";
import { asFrames, frame, node, png, imagePaint } from "./fixtures";

test("built HTML has bundled inline JavaScript that parses without CDN or placeholders", () => {
  execFileSync(process.execPath, ["scripts/build.mjs"]);
  const html = readFileSync("dist/ui.html", "utf8");
  assert.ok(!html.includes("/* INLINE_JS */"));
  assert.ok(!html.includes("/* INLINE_CSS */"));
  assert.ok(!/<script[^>]+src=/i.test(html));
  const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
  assert.doesNotThrow(() => new Script(script));
  assert.doesNotThrow(() => new Script(readFileSync("dist/main.js", "utf8")));
});

test("built plugin transfers chunked binary files with acknowledgements into a validated ZIP", async () => {
  const zip = new ProjectZip();
  let active: { path: string; bytes: Uint8Array; offset: number } | undefined;
  let chunks = 0;
  let selection: Extract<MainMessage, { type: "selection" }> | undefined;
  let complete: Extract<MainMessage, { type: "complete" }> | undefined;
  const original = new Uint8Array(600000);
  original.set(png);
  const frames = asFrames(
    frame("bundle:0", [node("RECTANGLE", "bundle:1", { fills: [imagePaint] })]),
    frame("bundle:2", []),
    frame("bundle:3", []),
  );
  const ui: {
    onmessage?: (message: UiMessage) => Promise<void>;
    postMessage: (message: MainMessage) => void;
  } = {
    postMessage(message) {
      switch (message.type) {
        case "selection":
          selection = message;
          break;
        case "file-start":
          assert.equal(active, undefined);
          active = {
            path: message.path,
            bytes: new Uint8Array(message.size),
            offset: 0,
          };
          break;
        case "file-chunk":
          assert.ok(active);
          assert.ok(message.bytes.length <= 256 * 1024);
          active.bytes.set(message.bytes, active.offset);
          active.offset += message.bytes.length;
          chunks++;
          queueMicrotask(() => {
            void ui.onmessage!({ type: "ack", sequence: message.sequence });
          });
          break;
        case "file-end":
          assert.ok(active);
          assert.equal(active.offset, active.bytes.length);
          zip.add(active.path, active.bytes);
          active = undefined;
          break;
        case "complete":
          complete = message;
          break;
        case "error":
          throw new Error(message.message);
      }
    },
  };
  const context = createContext({
    figma: {
      ui,
      currentPage: { id: "page:bundle", name: "Bundle", selection: frames },
      getImageByHash: () => ({ getBytesAsync: async () => original }),
      showUI: () => {},
      on: () => {},
      notify: () => {},
    },
    __html__: "<html></html>",
    setTimeout,
    clearTimeout,
    console,
    Uint8Array,
  });
  new Script(readFileSync("dist/main.js", "utf8")).runInContext(context);
  await ui.onmessage!({ type: "ready" });
  assert.equal(selection?.frames.length, 3);
  await ui.onmessage!({
    type: "export",
    ids: ["bundle:0", "bundle:2", "bundle:3"],
  });
  assert.ok(complete);
  assert.equal(complete.report.errorCount, 0);
  assert.equal(complete.report.frames, 3);
  assert.ok(chunks >= 5);
  assert.equal(active, undefined);
  const blob = await zip.generate(() => {});
  assert.ok(blob.size > 600000);
  await ui.onmessage!({ type: "packaged" });
});

class UiElementStub {
  textContent = "";
  disabled = false;
  hidden = false;
  value = 0;
  className = "";
  title = "";
  onclick?: () => void;
  children: UiElementStub[] = [];
  replaceChildren() {
    this.children = [];
  }
  append(...children: UiElementStub[]) {
    this.children.push(...children);
  }
}

test("built UI accepts Figma selection messages with null event.source and enables export", async () => {
  const html = readFileSync("dist/ui.html", "utf8");
  const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
  const elements = new Map<string, UiElementStub>();
  const getElement = (id: string) => {
    let element = elements.get(id);
    if (!element) {
      element = new UiElementStub();
      elements.set(id, element);
    }
    return element;
  };
  getElement("export").disabled = true;
  const sent: UiMessage[] = [];
  const parent = {
    postMessage: (envelope: { pluginMessage: UiMessage }) =>
      sent.push(envelope.pluginMessage),
  };
  const window: {
    onmessage?: (event: {
      source: null;
      data: { pluginMessage: MainMessage };
    }) => Promise<void>;
  } = {};
  const context = createContext({
    window,
    parent,
    document: {
      getElementById: getElement,
      createElement: () => new UiElementStub(),
    },
    console,
    setTimeout,
    clearTimeout,
    Uint8Array,
    TextEncoder,
    TextDecoder,
    Blob,
    URL,
  });
  new Script(script).runInContext(context);
  assert.equal(sent[0].type, "ready");
  await window.onmessage!({
    source: null,
    data: {
      pluginMessage: {
        type: "selection",
        frames: [
          {
            id: "ui:1",
            name: "01_INTRO",
            width: 1920,
            height: 1080,
            x: 0,
            y: 0,
          },
        ],
        counts: { nodes: 1, images: 0, vectors: 0, text: 0 },
        ignored: 0,
      },
    },
  });
  assert.equal(getElement("selection").textContent, "Selected Frames: 1");
  assert.equal(getElement("export").disabled, false);
  getElement("export").onclick!();
  assert.equal(sent.at(-1)?.type, "export");
  assert.equal(
    JSON.stringify(sent.at(-1)),
    JSON.stringify({ type: "export", ids: ["ui:1"] }),
  );
});
