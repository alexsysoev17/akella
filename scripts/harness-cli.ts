import {
  archiveMotionHistory,
  readMotion,
} from "../apps/scene-validator/src/motion/store.js";
import { loadProject } from "../apps/scene-validator/src/project.js";
import { runAgentEvals } from "../apps/scene-validator/src/harness/evals.ts";
import { evalFixture } from "./harness-fixtures.ts";
import {
  collectImprovements,
  evaluateCandidate,
  candidates,
} from "../apps/scene-validator/src/harness/improvements.ts";
import { readRuns } from "../apps/scene-validator/src/harness/runtime.ts";
import { harnessMetrics } from "../apps/scene-validator/src/harness/metrics.ts";
import path from "node:path";
const [command, ...args] = process.argv.slice(2);
const arg = (id: string, fallback?: string) => {
  const i = args.indexOf("--" + id);
  return i < 0 ? fallback : args[i + 1];
};
const root = arg("project");
const run = async (config?: Parameters<typeof runAgentEvals>[0]["config"]) =>
  runAgentEvals({
    dataset: arg("dataset", "harness/evals/dataset.json")!,
    output: arg("output", `artifacts/harness/eval-${Date.now()}.json`)!,
    provider: arg("provider", "codex-sdk")!,
    model: arg("model", ""),
    caseIds: arg("cases")?.split(","),
    fixture: evalFixture,
    keepFixtures: args.includes("--keep-fixtures"),
    config,
    onCase: (id, status) => console.log(id, status),
  });
if (command === "eval") console.log(JSON.stringify(await run(), null, 2));
else if (command === "archive-history") {
  if (!root) throw new Error("--project required");
  const project = await loadProject(root);
  console.log(
    JSON.stringify(
      await archiveMotionHistory(
        root,
        (await readMotion(project)).revision,
        Number(arg("keep", "100")),
      ),
      null,
      2,
    ),
  );
} else if (command === "metrics") {
  if (!root) throw new Error("--project required");
  console.log(JSON.stringify(harnessMetrics(await readRuns(root)), null, 2));
} else if (command === "improvements") {
  if (!root) throw new Error("--project required");
  console.log(JSON.stringify(await collectImprovements(root), null, 2));
} else if (command === "evaluate-improvement") {
  if (!root || !arg("id")) throw new Error("--project and --id required");
  console.log(
    JSON.stringify(await evaluateCandidate(root, arg("id")!, run), null, 2),
  );
} else
  throw new Error(
    "Commands: eval, metrics --project PATH, improvements --project PATH, evaluate-improvement --project PATH --id UUID",
  );
