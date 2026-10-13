import { fileURLToPath } from "node:url";
import { cp } from "node:fs/promises";
import { build } from "esbuild";
await build({
  entryPoints: [
    fileURLToPath(
      new URL("../apps/scene-validator/src/motion/browser.ts", import.meta.url),
    ),
  ],
  outfile: fileURLToPath(
    new URL(
      "../apps/scene-validator/src/web/motion-runtime.js",
      import.meta.url,
    ),
  ),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
});
await build({
  entryPoints: [
    fileURLToPath(
      new URL(
        "../apps/scene-validator/src/motion-library/easings/inspection.ts",
        import.meta.url,
      ),
    ),
  ],
  outfile: fileURLToPath(
    new URL(
      "../apps/scene-validator/src/web/easing-runtime.js",
      import.meta.url,
    ),
  ),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
});
await cp(
  new URL("../apps/scene-validator/src/web", import.meta.url),
  new URL("../apps/scene-validator/dist/src/web", import.meta.url),
  { recursive: true },
);

await cp(
  new URL("../apps/scene-validator/src/motion-library/skills", import.meta.url),
  new URL(
    "../apps/scene-validator/dist/src/motion-library/skills",
    import.meta.url,
  ),
  { recursive: true },
);
