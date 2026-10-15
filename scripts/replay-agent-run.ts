import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MotionState } from "../apps/scene-validator/src/motion/schema.ts";
import { isDeepStrictEqual } from "node:util";
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
if (args.includes("--recorded-state")) {
  const context = JSON.parse(
    await readFile(path.join(saved, "context.json"), "utf8"),
  );
  const doc = JSON.parse(
    await readFile(path.join(root, "motion/motion.json"), "utf8"),
  );
  const scenes = new Set(
    context.scenes?.map((s: { sceneId: string }) => s.sceneId),
  );
  if (!scenes.size || !context.motion)
    throw new Error("RECORDED_STATE_PROJECTION_UNAVAILABLE");
  const targets = new Set(
    context.scenes.flatMap((s: { objects: { targetId: string }[] }) =>
      s.objects.map((o) => o.targetId),
    ),
  );
  const projectState = (state: MotionState) =>
    JSON.parse(
      JSON.stringify({
        ...state,
        animations: state.animations.filter(
          (a) => scenes.has(a.sceneId) && targets.has(a.targetId),
        ),
        expressions: state.expressions?.filter(
          (e) => scenes.has(e.sceneId) && targets.has(e.targetId),
        ),
        visibility: state.visibility.filter((v) => scenes.has(v.sceneId)),
      }),
    );
  const states = [
    doc.state,
    ...doc.history.flatMap((e: { before: unknown; after: unknown }) => [
      e.before,
      e.after,
    ]),
  ].filter((s) => isDeepStrictEqual(projectState(s), context.motion));
  const unique = states.filter(
    (s, i) => states.findIndex((other) => isDeepStrictEqual(other, s)) === i,
  );
  if (unique.length !== 1)
    throw new Error(
      "RECORDED_STATE_NOT_UNIQUELY_VERIFIED_IN_HISTORY: " + unique.length,
    );
  doc.state = unique[0];
  doc.revision = context.projectRevision ?? request.revision;
  doc.history = [];
  doc.cursor = 0;
  await writeFile(
    path.join(root, "motion/motion.json"),
    JSON.stringify(doc, null, 2),
  );
  console.log(
    JSON.stringify({
      verifiedRecordedRevision: doc.revision,
      projectionScenes: [...scenes],
      authoritativeHistoricalMatches: states.length,
    }),
  );
}
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
