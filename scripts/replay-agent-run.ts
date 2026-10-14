import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadProject } from "../apps/scene-validator/src/project.ts";
import { readMotion } from "../apps/scene-validator/src/motion/store.ts";
import { executeMotion } from "../apps/scene-validator/src/motion/service.ts";
import { registerProvider } from "../apps/scene-validator/src/harness/providers/index.ts";
const args = process.argv.slice(2),
  arg = (name: string) => args[args.indexOf("--" + name) + 1];
if (!args.includes("--project") || !args.includes("--run"))
  throw new Error("--project PATH --run UUID required");
const original = path.resolve(arg("project")),
  run = z.uuid().parse(arg("run")),
  saved = path.join(original, "motion/ai", run);
const request = JSON.parse(
  await readFile(path.join(saved, "request.json"), "utf8"),
);
const response = JSON.parse(
  await readFile(
    path.join(saved, "semantic-interpret/raw-response.json"),
    "utf8",
  ),
);
const root = await mkdtemp(
  path.join(process.env.TMPDIR ?? "/tmp", "akella-replay-"),
);
await cp(original, root, {
  recursive: true,
  filter: (src) =>
    ![
      /\/motion\/(?:ai|qa|harness)(?:\/|$)/,
      /\/(?:history|validation|renders)(?:\/|$)/,
    ].some((pattern) => pattern.test(src)),
});
const project = await loadProject(root),
  before = await readMotion(project);
let calls = 0;
const stop = registerProvider("saved-run-reference", () => ({
  id: "saved-run-reference",
  mode: "mock",
  capabilities: () => ({
    structuredOutput: true,
    nativeToolCalling: false,
    cancellation: true,
    usage: false,
    nativeOutputTokenLimit: false,
  }),
  generate: async () => {
    calls++;
    return {
      output: response,
      usage: null,
      estimatedCost: null,
      latencyMs: 0,
      diagnostics: ["saved output replay, not live model"],
      toolCalls: [],
    };
  },
}));
try {
  const started = performance.now(),
    result = await executeMotion(
      project,
      {
        ...request.request,
        expectedRevision: before.revision,
        settings: { provider: "saved-run-reference", model: "" },
      },
      () => {},
      { config: { maxLLMCalls: 1, maxRepairAttempts: 0 } },
    );
  await writeFile(
    path.join(root, "replay-result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        copy: root,
        sourceRun: run,
        providerMode: "saved-output-replay",
        llmFixtureCalls: calls,
        latencyMs: performance.now() - started,
        reconciliation: result.reconciliation,
      },
      null,
      2,
    ),
  );
  if (result.reconciliation?.status !== "SUCCESS") process.exitCode = 1;
} finally {
  stop();
}
