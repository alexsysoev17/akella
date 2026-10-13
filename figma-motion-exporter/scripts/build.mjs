import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  target: "es2017",
  format: "iife",
});
const ui = await build({
  entryPoints: ["src/ui/main.ts"],
  bundle: true,
  write: false,
  target: "es2020",
  format: "iife",
});
const html = await readFile("src/ui/index.html", "utf8");
const css = await readFile("src/ui/styles.css", "utf8");
await writeFile(
  "dist/ui.html",
  html
    .replace("/* INLINE_CSS */", () => css)
    .replace("/* INLINE_JS */", () =>
      ui.outputFiles[0].text.replace(/<\/script/gi, "<\\/script"),
    ),
);
