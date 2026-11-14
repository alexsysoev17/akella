import { fontFamilyNames } from "./font-index.js";
import { createReadStream } from "node:fs";
import type { CanvasKit, FontMgr } from "canvaskit-wasm";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { LoadedProject } from "../types.js";
import { NativeRenderError, record, list } from "./skia.js";
export interface FontManifest {
  file: string;
  sha256: string;
  bytes: number;
  families: string[];
}
interface FontFile extends FontManifest {
  path: string;
}
export interface FontResources {
  manager: FontMgr;
  families: Set<string>;
  manifest: FontManifest[];
  catalogDigest: string;
  dispose(): void;
}
interface FontRequest {
  families: string[];
  unicode: boolean;
  emoji: boolean;
}
let catalog: Promise<FontFile[]> | undefined;
const resources = new Map<string, Promise<FontResources>>();
export function projectFonts(project: LoadedProject): FontRequest {
  const families = new Set<string>(),
    chars: string[] = [];
  function visit(v: unknown) {
    const n = record(v),
      t = record(n.text);
    if (n.type === "TEXT") {
      chars.push(String(t.characters ?? ""));
      for (const run of [t, ...list(t.segments)]) {
        const name = record(run.fontName);
        if (typeof name.family === "string") families.add(name.family);
      }
    }
    if (Array.isArray(n.children)) n.children.forEach(visit);
  }
  project.inspection.document.scenes.forEach(visit);
  if (!families.size) families.add("Arial");
  const characters = chars.join("");
  return {
    families: [...families].sort(),
    unicode: [...characters].some((c) => c.codePointAt(0)! > 0x500),
    emoji: [...characters].some((c) => c.codePointAt(0)! >= 0x1f000),
  };
}
/** Index font metadata once, releasing each temporary font immediately; never retain all font bytes. */
async function fontCatalog(kit: CanvasKit) {
  return (catalog ??= (async () => {
    const roots =
      process.env.AKELLA_FONT_DIRS?.split(path.delimiter) ??
      (process.platform === "darwin"
        ? [
            path.join(os.homedir(), "Library/Fonts"),
            "/Library/Fonts",
            "/System/Library/Fonts/Supplemental",
            "/System/Library/Fonts",
          ]
        : process.platform === "win32"
          ? [
              path.join(process.env.WINDIR ?? "C:\\Windows", "Fonts"),
              path.join(os.homedir(), "AppData/Local/Microsoft/Windows/Fonts"),
            ]
          : [
              path.join(os.homedir(), ".local/share/fonts"),
              "/usr/share/fonts",
              "/usr/local/share/fonts",
            ]);
    const files = new Set<string>();
    async function visit(root: string, depth = 0): Promise<void> {
      if (depth > 5 || files.size >= 4096) return;
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const file = path.join(root, entry.name);
        if (entry.isDirectory()) await visit(file, depth + 1);
        else if (entry.isFile() && /\.(ttf|otf|ttc)$/i.test(file))
          files.add(file);
      }
    }
    for (const root of roots) await visit(root);
    const result: FontFile[] = [];
    for (const file of files) {
      const size = (await stat(file)).size;
      if (size > 64 * 1024 * 1024) continue;
      let families: string[];
      try {
        families = await fontFamilyNames(file);
      } catch {
        continue;
      }
      if (!families.length) continue;
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      result.push({
        path: file,
        file: path.basename(file),
        sha256: hash.digest("hex"),
        bytes: size,
        families,
      });
    }
    if (!result.length)
      throw new NativeRenderError(
        "FONT_RESOURCES_MISSING",
        "Set AKELLA_FONT_DIRS to installed licensed fonts",
      );
    return result;
  })());
}
export async function fontCatalogDigest(kit: CanvasKit) {
  return createHash("sha256")
    .update(JSON.stringify((await fontCatalog(kit)).map(({ path, ...v }) => v)))
    .digest("hex");
}
/** Load only requested/fallback faces, with shared reference-counted native font managers. */
export async function fonts(
  kit: CanvasKit,
  request: FontRequest = { families: ["Arial"], unicode: false, emoji: false },
): Promise<FontResources> {
  const key = JSON.stringify(request);
  let pending = resources.get(key);
  if (!pending) {
    let users = 0;
    pending = (async () => {
      const index = await fontCatalog(kit),
        wanted = new Set(
          [
            ...request.families,
            "Arial",
            "Helvetica",
            "DejaVu Sans",
            "Liberation Sans",
            ...(request.unicode
              ? ["Arial Unicode MS", "Noto Sans", "Noto Sans CJK SC"]
              : []),
            ...(request.emoji ? ["Apple Color Emoji", "Noto Color Emoji"] : []),
          ].map((v) => v.toLowerCase()),
        );
      let selected = index.filter((v) =>
        v.families.some((f) => wanted.has(f.toLowerCase())),
      );
      if (!selected.length) selected = [index[0]];
      const total = selected.reduce((n, f) => n + f.bytes, 0);
      if (total > 192 * 1024 * 1024)
        throw new NativeRenderError(
          "FONT_RESOURCE_LIMIT",
          "Requested font files exceed 192MiB",
        );
      const buffers = [];
      for (const entry of selected){
        const bytes=await readFile(entry.path);
        if(createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw new NativeRenderError('FONT_CATALOG_CHANGED_RESTART_REQUIRED','Installed font bytes changed after indexing; restart the renderer');
        buffers.push(Uint8Array.from(bytes).buffer);
      }
      const manager = kit.FontMgr.FromData(...buffers);
      if (!manager)
        throw new NativeRenderError(
          "FONT_RESOURCES_INVALID",
          "Skia rejected requested faces",
        );
      const result = {
        manager,
        families: new Set(
          Array.from({ length: manager.countFamilies() }, (_, i) =>
            manager.getFamilyName(i),
          ),
        ),
        manifest: selected.map(({ path, ...v }) => v),
        catalogDigest: await fontCatalogDigest(kit),
        dispose() {
          if (--users === 0) {
            manager.delete();
            resources.delete(key);
          }
        },
      };
      return Object.assign(result, {
        retain() {
          users++;
        },
      });
    })();
    resources.set(key, pending);
  }
  const resource = (await pending) as FontResources & { retain(): void };
  resource.retain();
  return resource;
}
