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
await build({
  entryPoints: [
    fileURLToPath(
      new URL(
        "../apps/scene-validator/src/provider-contract.ts",
        import.meta.url,
      ),
    ),
  ],
  outfile: fileURLToPath(
    new URL(
      "../apps/scene-validator/src/web/provider-contract.js",
      import.meta.url,
    ),
  ),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
});
// Explicit brand allowlist; reference screenshots and other local assets are never served.
for (const name of ["akella.svg", "akella_photo.png", "Inter-Light.ttf", "Inter-Medium.ttf", "Inter-Regular.ttf", "Inter-Bold.ttf"]) {
  await cp(new URL(`../assets/${name}`, import.meta.url),
    new URL(`../apps/scene-validator/src/web/brand/${name}`, import.meta.url));
}
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

// Native worker is a Node-only bundle; it is never sent to the browser.
await build({
  entryPoints: [
    fileURLToPath(
      new URL("../apps/scene-validator/src/native/worker.ts", import.meta.url),
    ),
  ],
  outfile: fileURLToPath(
    new URL(
      "../apps/scene-validator/src/native/worker-runtime.mjs",
      import.meta.url,
    ),
  ),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  packages: "external",
});
await cp(
  new URL(
    "../apps/scene-validator/src/native/worker-runtime.mjs",
    import.meta.url,
  ),
  new URL(
    "../apps/scene-validator/dist/src/native/worker-runtime.mjs",
    import.meta.url,
  ),
);

await cp(new URL("../apps/scene-validator/src/harness/providers/codex-stream-proxy.mjs",import.meta.url),new URL("../apps/scene-validator/dist/src/harness/providers/codex-stream-proxy.mjs",import.meta.url));
