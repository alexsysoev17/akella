import { z } from "zod";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LoadedProject } from "../types.js";
import type { MotionState } from "../motion/schema.js";
import { executeMotion } from "../motion/service.js";
import { readMotion } from "../motion/store.js";
import { readRuns } from "./runtime.js";
import { harnessMetrics } from "./metrics.js";
import { digest } from "./context.js";
import { createProvider } from "./providers/index.js";
import type { HarnessConfig } from "./config.js";
const evalCaseSchema = z
  .object({
    evalId: z.string(),
    prompt: z.string(),
    fixture: z.string(),
    seed: z.string(),
    target: z.string(),
    scene: z.string(),
    expectedCapabilities: z.array(z.string()),
    checks: z.array(z.string()),
  })
  .strict();
export const evalDatasetSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    version: z.string(),
    cases: z.array(evalCaseSchema),
  })
  .strict();
export type AgentEval = z.infer<typeof evalCaseSchema>;
export interface EvalFixture {
  project: LoadedProject;
  cleanup: () => Promise<void>;
}
export async function runAgentEvals(options: {
  dataset: string;
  output: string;
  provider: string;
  model?: string;
  caseIds?: string[];
  config?: Partial<HarnessConfig>;
  fixture: (c: AgentEval) => Promise<EvalFixture>;
  keepFixtures?: boolean;
  onCase?: (id: string, status: string) => void;
}) {
  const dataset = evalDatasetSchema.parse(
      JSON.parse(await readFile(options.dataset, "utf8")),
    ),
    datasetVersion = digest(dataset),
    cases = dataset.cases.filter(
      (c) => !options.caseIds?.length || options.caseIds.includes(c.evalId),
    );
  if (!cases.length) throw new Error("No eval cases selected");
  const rows: EvalRow[] = [];
  const runs: Awaited<ReturnType<typeof readRuns>> = [];
  for (const c of cases) {
    options.onCase?.(c.evalId, "RUNNING");
    const fixture = await options.fixture(c);
    try {
      const before = await readMotion(fixture.project);
      let response: Awaited<ReturnType<typeof executeMotion>> | undefined,
        error: string | undefined;
      try {
        response = await executeMotion(
          fixture.project,
          {
            mode: c.seed === "none" ? "create" : "edit",
            request: c.prompt,
            selectedObjectId: c.target,
            selectedSceneId: c.scene,
            activeSceneId: c.scene,
            settings: {
              provider: options.provider,
              model: options.model ?? "",
            },
            expectedRevision: before.revision,
          },
          () => {},
          {
            config: options.config,
            evalContext: { evalId: c.evalId, datasetVersion },
          },
        );
      } catch (e) {
        error = String(e);
      }
      const after = await readMotion(fixture.project);
      const recorded = await readRuns(fixture.project.root);
      runs.push(...recorded);
      const checks = evalChecks(c, before.state, after.state, response);
      const status =
        !error &&
        response?.reconciliation?.status === "SUCCESS" &&
        checks.every((x) => x.status === "PASSED")
          ? "PASSED"
          : "FAILED";
      const row: EvalRow = {
        evalId: c.evalId,
        prompt: c.prompt,
        fixtureProject: fixture.project.root,
        fixtureType: "artificial export",
        expectedCapabilities: c.expectedCapabilities,
        status,
        checks,
        error,
        runIds: recorded.map((r) => String(r.runId)),
        llmCalls: recorded.reduce((n, r) => n + (r.metrics?.llmCalls ?? 0), 0),
      };
      rows.push(row);
      options.onCase?.(c.evalId, status);
      await mkdir(path.dirname(options.output), { recursive: true });
      await writeFile(
        options.output,
        JSON.stringify(
          {
            schemaVersion: "1.0.0",
            datasetVersion,
            provider: options.provider,
            providerMode: createProvider(options.provider, fixture.project.root)
              .mode,
            complete: rows.length === dataset.cases.length,
            datasetCaseIds: dataset.cases.map((c) => c.evalId),
            results: rows,
            metrics: harnessMetrics(runs),
            runReports: runs,
          },
          null,
          2,
        ),
      );
    } finally {
      if (!options.keepFixtures) await fixture.cleanup();
    }
  }
  return JSON.parse(await readFile(options.output, "utf8")) as {
    datasetVersion: string;
    providerMode: "live" | "mock";
    complete: boolean;
    results: EvalRow[];
    metrics: ReturnType<typeof harnessMetrics>;
  };
}
interface EvalRow {
  evalId: string;
  prompt: string;
  fixtureProject: string;
  fixtureType: string;
  expectedCapabilities: string[];
  status: string;
  checks: { name: string; status: string }[];
  error?: string;
  runIds: string[];
  llmCalls: number;
}
export function evalChecks(
  c: AgentEval,
  before: MotionState,
  after: MotionState,
  response?: Awaited<ReturnType<typeof executeMotion>>,
) {
  const checks: { name: string; status: string }[] = [];
  const add = (name: string, ok: boolean) =>
    checks.push({ name, status: ok ? "PASSED" : "FAILED" });
  const own = (a: { targetId: string }) => a.targetId === c.target;
  for (const name of c.checks) {
    if (name === "qa")
      add(
        name,
        !!response?.requirements?.length &&
          (response.requirements as { qaResult?: unknown }[]).every((r) =>
            ["PASSED", "WARNING"].includes(
              (r.qaResult as { status?: string })?.status ?? "",
            ),
          ),
      );
    else if (name === "trueTrim") {
      add(
        name,
        after.animations.some(
          (a) =>
            (a.effect === "trimPath" && a.targetId === "line") ||
            (a.effect === "trimPath" &&
              ["ribbon1", "ribbon2"].includes(a.targetId)),
        ),
      );
      add(
        "noScaleReveal",
        !after.animations.some(
          (a) => a.targetId === "line" && a.effect.startsWith("scale"),
        ),
      );
    } else if (name === "procedural")
      add(
        name,
        !!after.expressions?.some(
          (e) =>
            e.type === "inertialOvershoot" &&
            own(e) &&
            after.animations.some(
              (a) =>
                "sourceAnimationId" in e &&
                a.animationId === e.sourceAnimationId &&
                e.startFrame === a.startFrame + a.durationFrames,
            ),
        ),
      );
    else if (name === "amplitudeHalf")
      add(
        name,
        (before.expressions ?? [])
          .filter(own)
          .every(
            (e) =>
              after.expressions?.find((n) => n.expressionId === e.expressionId)
                ?.parameters.amplitude ===
              e.parameters.amplitude * 0.5,
          ),
      );
    else if (name === "frequencyFactor")
      add(
        name,
        (before.expressions ?? [])
          .filter(own)
          .every(
            (e) =>
              "frequency" in e.parameters &&
              after.expressions?.some(
                (n) =>
                  n.expressionId === e.expressionId &&
                  "frequency" in n.parameters &&
                  n.parameters.frequency ===
                    ("frequency" in e.parameters
                      ? e.parameters.frequency
                      : NaN) *
                      1.5,
              ),
          ),
      );
    else if (name === "baseUnchanged")
      add(
        name,
        JSON.stringify(before.animations) === JSON.stringify(after.animations),
      );
    else if (name === "logicalTransition")
      add(
        name,
        after.objectTransitions?.length === 1 &&
          after.objectTransitions[0].fromSceneId !==
            after.objectTransitions[0].toSceneId,
      );
    else if (name === "customEasing")
      add(
        name,
        after.animations
          .filter(own)
          .some(
            (a) =>
              typeof a.easing === "object" &&
              ["cubicBezier", "piecewise"].includes(a.easing.type),
          ),
      );
    else if (name === "moveScale")
      add(
        name,
        after.animations.some((a) => own(a) && a.effect === "moveTo") &&
          after.animations.some(
            (a) =>
              own(a) &&
              a.effect === "scaleIn" &&
              a.parameters.to > a.parameters.from,
          ),
      );
    else if (name === "composite10") {
      add("tenRequirements", response?.requirements?.length === 10);
      add(
        "sceneTiming",
        after.blocks[1].startFrame === after.settings.fps &&
          after.blocks[2].startFrame === 3 * after.settings.fps,
      );
      for (const id of ["image", "text", "qr", "logo", "discount", "shape"])
        add(
          "slideFade:" + id,
          after.animations.some(
            (a) => a.targetId === id && a.effect === "slideUp",
          ) &&
            after.animations.some(
              (a) => a.targetId === id && a.effect === "fadeIn",
            ),
        );
      add(
        "fourInertia",
        after.expressions?.filter((e) => e.type === "inertialOvershoot")
          .length === 4,
      );
      const first = after.animations.find(
          (a) => a.targetId === "ribbon1" && a.effect === "trimPath",
        ),
        second = after.animations.find(
          (a) => a.targetId === "ribbon2" && a.effect === "trimPath",
        );
      add(
        "orderedRibbons",
        !!first &&
          !!second &&
          second.startFrame === first.startFrame + first.durationFrames,
      );
      add(
        "noLogoTrim",
        !after.animations.some(
          (a) => a.targetId === "logo" && a.effect === "trimPath",
        ),
      );
    } else throw new Error("Unknown eval check: " + name);
  }
  return checks;
}
