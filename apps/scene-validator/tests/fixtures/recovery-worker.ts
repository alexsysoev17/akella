import { lockProject, atomicJson } from "../../src/files.js";
import { loadProject } from "../../src/project.js";
import { readMotion, changeMotion } from "../../src/motion/store.js";
const [mode, root, id] = process.argv.slice(2);
if (mode === "lock") {
  await lockProject(root);
  process.send?.("LOCKED");
}
if (mode === "commit") {
  const p = await loadProject(root),
    d = await readMotion(p);
  await changeMotion(root, {
    expectedRevision: d.revision,
    transactionId: id,
    operations: [
      {
        type: "setProjectSettings",
        settings: { ...d.state.settings, fps: 24 },
      },
    ],
    request: "crash fixture",
    origin: "manual",
  });
  process.send?.("COMMITTED");
}
if (mode === "write") {
  process.send?.("WRITING");
  for (let i = 0; i < 100; i++)
    await atomicJson(root, { generation: i, payload: "x".repeat(5000000) });
}
setInterval(() => {}, 1000);
