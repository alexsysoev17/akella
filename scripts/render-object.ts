import { loadProject } from "../apps/scene-validator/src/project.js";
import { readMotion } from "../apps/scene-validator/src/motion/store.js";
import { renderIsolatedObject } from "../apps/scene-validator/src/motion/qa/geometry.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const args = process.argv.slice(2);
function arg(name: string, defaultValue?: string) {
  const i = args.indexOf("--" + name);
  const value = i >= 0 ? args[i + 1] : defaultValue;
  if (value === undefined) throw new Error("--" + name + " required");
  return value;
}
const project = await loadProject(arg("project")),
  state = (await readMotion(project)).state;
const scene = arg("scene"),
  target = arg("target"),
  frame = Number(arg("frame", "0")),
  out = path.resolve(arg("output", "artifacts/isolated-object"));
if (!Number.isFinite(frame)) throw new Error("Invalid frame");
await mkdir(out, { recursive: true });
for (const baseline of [true, false]) {
  const result = await renderIsolatedObject(
    project,
    state,
    scene,
    target,
    frame,
    baseline,
  );
  await writeFile(
    path.join(out, baseline ? "baseline.png" : "animated.png"),
    result.png,
  );
  await writeFile(
    path.join(out, baseline ? "baseline.json" : "animated.json"),
    JSON.stringify(result.diagnostic, null, 2),
  );
}
console.log(out);
