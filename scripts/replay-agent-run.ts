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
const live=args.includes("--live-original-provider");
const response = live?undefined:JSON.parse(
  await readFile(
    args.includes("--response-file") ? path.resolve(arg("response-file")) : path.join(saved, "semantic-interpret/raw-response.json"),
    "utf8",
  ),
);
const resolution = args.includes("--resolution-file") ? JSON.parse(await readFile(path.resolve(arg("resolution-file")), "utf8")) : undefined;
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
  const context = await readFile(path.join(saved,"context.json"),"utf8").then(JSON.parse).catch(async error=>{
    if(error.code!=="ENOENT")throw error;
    const doc=await readMotion(await loadProject(root));
    if(doc.revision!==request.revision)throw Error("RECORDED_STATE_UNAVAILABLE_FOR_CHANGED_PROJECT");
    return {motion:doc.state,projectRevision:doc.revision,scenes:(await loadProject(root)).inspection.document.scenes.map(s=>({sceneId:s.sceneId,objects:[]})),unprojectedStartup:true};
  });
  const doc = await readFile(path.join(root,"motion/motion.json"),"utf8").then(JSON.parse).catch(async error=>{
    if(error.code!=="ENOENT"||request.revision!=="initial")throw error;
    return readMotion(await loadProject(root));
  });
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
  const projectState = (state: MotionState) => context.unprojectedStartup?state:
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
const stop = live?()=>{}:registerProvider("saved-run-reference", () => ({
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
      output: calls === 1 || !resolution ? response : resolution,
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
        settings: live?request.request.settings:{ provider: "saved-run-reference", model: "" },
      },
      () => {},
      { config: { maxLLMCalls: resolution ? 2 : 1, maxRepairAttempts: resolution ? 1 : 0 } },
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
        providerMode: live?"live-original-provider":"saved-output-replay",
        llmFixtureCalls: calls,
        latencyMs: performance.now() - started,
        reconciliation: result.reconciliation,
      },
      null,
      2,
    ),
  );
  if(args.includes("--report-file"))await writeFile(path.resolve(arg("report-file")),JSON.stringify({copy:root,resultFile:path.join(root,"replay-result.json"),sourceRun:run,reconciliation:result.reconciliation,providerMode:live?"live-original-provider":"saved-output-replay"}),{flag:"wx"});
  if (result.reconciliation?.status !== "SUCCESS") process.exitCode = 1;
} finally {
  stop();
}
