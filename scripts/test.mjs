import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
const root = "apps/scene-validator/tests/";
const historical = (await readdir(root))
  .filter((n) => n.endsWith(".test.ts") && !n.startsWith("native-"))
  .sort()
  .map((n) => root + n);
async function run(files, renderer) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--test", "--test-concurrency=1", ...files],
      {
        stdio: "inherit",
        env: { ...process.env, AKELLA_RENDERER: renderer, AKELLA_MOTION_RUNTIME: process.env.AKELLA_MOTION_RUNTIME ?? "legacy" },
        shell: false,
      },
    );
    child.on("error", reject);
    child.on("exit", resolve);
  });
  if (code !== 0) process.exit(Number(code) || 1);
}
// Existing browser-specific assertions remain unchanged and explicitly exercise compatibility.
if (!process.argv.includes("--native")) {
  await run(historical, "browser-compat");
  await run([root + "text-placement.browser.ts"], "browser-compat");
}
const native = (await readdir(root))
  .filter((n) => n.startsWith("native-") && n.endsWith(".test.ts"))
  .sort()
  .map((n) => root + n);
if (native.length && !process.argv.includes("--compat"))
  await run(native, "native");
