import { expandInheritance } from "../motion/intent/compiler.js";
import { evaluateVideoConsistency } from "./video-eval.js";
import { z } from "zod";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LoadedProject } from "../types.js";
import type { MotionState } from "../motion/schema.js";
import { executeMotion } from "../motion/service.js";
import { readMotion, changeMotion } from "../motion/store.js";
import { evaluateMotion } from "../motion/engine.js";
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
    expectedFailure: z.boolean().optional(),
    expectedStatus: z.enum(["SUCCESS", "PARTIAL_SUCCESS", "FAILED"]).optional(),
    referenceOutput: z.unknown().optional(),
    turns: z
      .array(
        z
          .object({
            prompt: z.string(),
            referenceOutput: z.unknown().optional(),
            editorAction: z.enum(["undo", "redo"]).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(10)
      .optional(),
    expectations: z
      .array(
        z
          .object({
            target: z.string(),
            scene: z.string(),
            techniques: z.array(z.string()),
            startFrame: z.number().int().optional(),
            amplitudeFactor: z.number().optional(),
          })
          .strict(),
      )
      .optional(),
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
  verifyVideo?: boolean;
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
      const turnChecks: { name: string; status: string }[] = [];
      const interpreted: ReturnType<typeof expandInheritance>["requirements"] =
        [];
      let turnNumber = 0;
      try {
        for (const turn of c.turns ?? [{ prompt: c.prompt }]) {
          turnNumber++;
          const turnBefore = await readMotion(fixture.project);
          if ("editorAction" in turn && turn.editorAction) {
            const expected =
              turn.editorAction === "undo"
                ? turnBefore.history[turnBefore.cursor - 1]?.before
                : turnBefore.history[turnBefore.cursor]?.after;
            const changed = await changeMotion(fixture.project.root, {
              expectedRevision: turnBefore.revision,
              request: turn.prompt,
              action: turn.editorAction,
            });
            turnChecks.push({
              name: "editor " + turn.editorAction,
              status:
                expected && digest(changed.document.state) === digest(expected)
                  ? "PASSED"
                  : "FAILED",
            });
            continue;
          }

          response = await executeMotion(
            fixture.project,
            {
              mode: c.seed === "none" ? "create" : "edit",
              request: turn.prompt,
              selectedObjectId: c.target,
              selectedSceneId: c.scene,
              activeSceneId: c.scene,
              settings: {
                provider: options.provider,
                model: options.model ?? "",
              },
              expectedRevision: turnBefore.revision,
            },
            () => {},
            {
              config: options.config,
              evalContext: { evalId: c.evalId, datasetVersion },
            },
          );
          if (response.intentContract)
            interpreted.push(
              ...expandInheritance(response.intentContract).requirements,
            );
          if (response.reconciliation?.status !== "SUCCESS") break;
          const turnAfter = await readMotion(fixture.project);
          turnChecks.push({
            name: "one durable run commit and matching receipt",
            status:
              turnAfter.lastCommit?.transactionId === response.id &&
              turnAfter.lastCommit?.revision === turnAfter.revision &&
              turnAfter.history.length === turnBefore.cursor + 1
                ? "PASSED"
                : "FAILED",
          });
          turnChecks.push(
            ...evalChecks(
              {
                ...c,
                prompt: turn.prompt,
                expectations: undefined,
                checks: ["qa"],
              },
              turnBefore.state,
              turnAfter.state,
              response,
            ).map((check) => ({
              ...check,
              name: `turn ${turnNumber}: ${check.name}`,
            })),
          );
        }
      } catch (e) {
        error = String(e);
      }
      const after = await readMotion(fixture.project);
      const recorded = await readRuns(fixture.project.root);
      runs.push(...recorded);
      const checks = c.expectedFailure
        ? [
            {
              name: "expected rejection",
              status:
                !response?.reconciliation?.completed &&
                JSON.stringify(before.state) === JSON.stringify(after.state)
                  ? "PASSED"
                  : "FAILED",
            },
          ]
        : [
            ...evalChecks(c, before.state, after.state, response),
            ...turnChecks,
          ];
      const videoQA =
        options.verifyVideo &&
        !c.expectedFailure &&
        response?.reconciliation?.status === "SUCCESS"
          ? await evaluateVideoConsistency(fixture.project)
          : { status: "NOT_TESTED" };
      const status =
        (c.expectedFailure
          ? !!error || response?.reconciliation?.status === "FAILED"
          : !error &&
            response?.reconciliation?.status ===
              (c.expectedStatus ?? "SUCCESS")) &&
        checks.every((x) => x.status === "PASSED") &&
        videoQA.status !== "FAILED"
          ? "PASSED"
          : "FAILED";

      const semanticChecks = c.expectations?.length
        ? c.expectations.every((expected) =>
            interpreted.some(
              (r) =>
                r.target.sourceNodeId === expected.target &&
                r.sceneId === expected.scene &&
                expected.techniques.every((t) =>
                  r.techniques.includes(t as (typeof r.techniques)[number]),
                ),
            ),
          )
        : null;
      const compileChecks = response?.tasks?.length
        ? response.tasks.every(
            (t: { operationCoverage?: { status?: string } }) =>
              t.operationCoverage?.status === "PASSED",
          )
        : null;
      const row: EvalRow = {
        expectedOutcome: c.expectedFailure
          ? "REJECT"
          : (c.expectedStatus ?? "SUCCESS"),
        evalId: c.evalId,
        prompt: c.prompt,
        fixtureProject: fixture.project.root,
        fixtureType: "artificial export",
        expectedCapabilities: c.expectedCapabilities,
        status,
        checks,
        error,
        runIds: recorded.map((r) => String(r.runId)),
        turnCount: c.turns?.length ?? 1,
        videoQA,
        stages: {
          semantic:
            createProvider(options.provider, fixture.project.root).mode ===
            "mock"
              ? "NOT_TESTED_MOCK"
              : semanticChecks === null
                ? "NOT_TESTED"
                : semanticChecks
                  ? "PASSED"
                  : "FAILED",
          compilation:
            compileChecks === null
              ? "NOT_TESTED"
              : compileChecks
                ? "PASSED"
                : "FAILED",
          execution:
            JSON.stringify(before.state) !== JSON.stringify(after.state)
              ? response?.reconciliation?.status === "SUCCESS"
                ? "PASSED"
                : "PARTIAL"
              : c.expectedFailure
                ? "CORRECT_REJECTION"
                : response?.reconciliation?.status === "SUCCESS"
                  ? "PASSED_NO_STATE_DIFF"
                  : "NO_CHANGE",
          visual: response?.requirements?.length
            ? response.requirements.every(
                (r: { qaResult?: unknown }) =>
                  (r.qaResult as { status?: string })?.status === "PASSED",
              )
              ? "PASSED"
              : "WARNING_OR_FAILED"
            : "NOT_TESTED",
        },
        performance: recorded.map((r) => r.metrics),
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
            model: options.model ?? "",
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
    provider: string;
    model: string;
    complete: boolean;
    results: EvalRow[];
    metrics: ReturnType<typeof harnessMetrics>;
  };
}
interface EvalRow {
  expectedOutcome?: string;
  evalId: string;
  prompt: string;
  fixtureProject: string;
  fixtureType: string;
  expectedCapabilities: string[];
  status: string;
  checks: { name: string; status: string }[];
  error?: string;
  runIds: string[];
  turnCount?: number;
  videoQA?: unknown;
  stages?: Record<string, string>;
  performance?: unknown[];
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
    else if (name === "preserveOtherExpressions") {
      const targets = new Set(c.expectations?.map((e) => e.target) ?? []);
      add(
        name,
        (before.expressions ?? [])
          .filter((e) => !targets.has(e.targetId))
          .every(
            (e) =>
              JSON.stringify(e) ===
              JSON.stringify(
                after.expressions?.find(
                  (n) => n.expressionId === e.expressionId,
                ),
              ),
          ),
      );
    } else if (name === "frequencyIncreased") {
      const previous = (before.expressions ?? []).filter(own);
      add(
        name,
        previous.length > 0 &&
          previous.every((e) => {
            const next = after.expressions?.find(
              (n) => n.expressionId === e.expressionId,
            );
            return (
              next &&
              "frequency" in e.parameters &&
              "frequency" in next.parameters &&
              next.parameters.frequency > e.parameters.frequency
            );
          }),
      );
    } else if (name === "baseUnchanged")
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
    } else if (name === "textLocalInertia") {
      const tracks = after.animations.filter((a) => a.targetId === c.target);
      const slide = tracks.find((a) => a.effect === "slideDown");
      add(
        name,
        tracks.length === 2 &&
          tracks.every(
            (a) => a.text?.segmentation === "line" && a.text.staggerFrames > 0,
          ) &&
          !!after.expressions?.some(
            (e) =>
              e.targetId === c.target &&
              e.type === "inertialOvershoot" &&
              "sourceAnimationId" in e &&
              e.sourceAnimationId === slide?.animationId,
          ),
      );
    } else if (name === "textBlockTracks")
      add(
        name,
        after.animations.filter((a) => a.targetId === c.target).length === 2 &&
          after.animations
            .filter((a) => a.targetId === c.target)
            .every((a) => a.text?.segmentation === "block"),
      );
    else if (name === "twoTrimTracks")
      add(
        name,
        after.animations.filter((a) => a.effect === "trimPath").length === 2,
      );
    else if (name === "noTimingDependencies")
      add(name, !after.timingDependencies?.length);
    else if (name === "timingAt21")
      add(
        name,
        after.animations.find((a) => a.targetId === "line2")?.startFrame ===
          21 && after.timingDependencies?.length === 1,
      );
    else if (name === "fadeAfterPosition")
      add(
        name,
        after.animations.find(
          (a) => a.targetId === "phone" && a.effect === "fadeIn",
        )?.startFrame === 15 && after.timingDependencies?.length === 1,
      );
    else if (name === "noTrimTracks")
      add(name, !after.animations.some((a) => a.effect === "trimPath"));
    else if (name === "dependencyIntegrity")
      add(
        name,
        (after.timingDependencies ?? []).every(
          (d) =>
            after.animations.some((a) => a.animationId === d.animationId) &&
            after.animations.some((a) => a.animationId === d.anchorAnimationId),
        ),
      );
    else if (name === "reverseSpatial")
      add(
        name,
        after.animations.filter((a) => a.effect === "trimPath").length === 2 &&
          after.animations
            .filter((a) => a.effect === "trimPath")
            .every(
              (a) =>
                a.parameters.direction === "reverse" &&
                a.parameters.from === 0 &&
                a.parameters.to === 1,
            ),
      );
    else if (name === "trackIdsPreserved")
      add(
        name,
        JSON.stringify(
          before.animations
            .filter((a) => a.effect === "trimPath")
            .map((a) => a.animationId)
            .sort(),
        ) ===
          JSON.stringify(
            after.animations
              .filter((a) => a.effect === "trimPath")
              .map((a) => a.animationId)
              .sort(),
          ),
      );
    else if (name === "fadeRemoved")
      add(
        name,
        !after.animations.some(
          (a) => a.targetId === "qr" && a.effect === "fadeIn",
        ),
      );
    else if (name === "inertiaRemoved")
      add(
        name,
        !after.expressions?.some((e) => e.type === "inertialOvershoot"),
      );
    else if (name === "dependentStartPreserved")
      add(
        name,
        after.animations.find((a) => a.targetId === "line2")?.startFrame ===
          before.animations.find((a) => a.targetId === "line2")?.startFrame,
      );
    else if (
      !["frameScheduling", "sequence", "compoundNumerical"].includes(name)
    )
      throw new Error("Unknown eval check: " + name);
  }
  if (c.checks.includes("frameScheduling"))
    add(
      "frameScheduling",
      after.blocks[1]?.startFrame === 30 && after.blocks[2]?.startFrame === 90,
    );
  if (c.checks.includes("sequence")) {
    const dependencies = after.timingDependencies ?? [];
    add(
      "structured dependency",
      dependencies.length > 0 &&
        dependencies.every((d) => {
          const a = after.animations.find(
              (a) => a.animationId === d.animationId,
            ),
            anchor = after.animations.find(
              (a) => a.animationId === d.anchorAnimationId,
            );
          return (
            a &&
            anchor &&
            d.relation === "after" &&
            a.startFrame ===
              anchor.startFrame + anchor.durationFrames + d.offsetFrames
          );
        }),
    );
  }
  if (c.checks.includes("compoundNumerical"))
    for (const fade of after.animations.filter((a) => a.effect === "fadeIn")) {
      const base = after.animations.find(
        (a) =>
          a.targetId === fade.targetId &&
          a.sceneId === fade.sceneId &&
          a.effect.startsWith("slide"),
      );
      if (base) {
        const key = JSON.stringify([fade.sceneId, fade.targetId]);
        add(
          `simultaneous:${fade.targetId}`,
          base.startFrame === fade.startFrame &&
            base.durationFrames === fade.durationFrames,
        );
        add(
          `opacity:${fade.targetId}`,
          evaluateMotion(after, fade.startFrame).nodes[key]?.opacity === 0 &&
            evaluateMotion(after, fade.startFrame + fade.durationFrames).nodes[
              key
            ]?.opacity === 1,
        );
        const e = after.expressions?.find(
          (e) =>
            e.targetId === fade.targetId &&
            e.sceneId === fade.sceneId &&
            e.type === "inertialOvershoot",
        );
        add(
          `afterMotion:${fade.targetId}`,
          !!e &&
            "sourceAnimationId" in e &&
            e.sourceAnimationId === base.animationId &&
            e.startFrame === base.startFrame + base.durationFrames,
        );
      }
    }
  for (const expected of c.expectations ?? []) {
    for (const technique of expected.techniques) {
      const animation = after.animations.find(
        (a) =>
          a.targetId === expected.target &&
          a.sceneId === expected.scene &&
          a.effect === technique,
      );
      const expression = after.expressions?.find(
        (e) =>
          e.targetId === expected.target &&
          e.sceneId === expected.scene &&
          e.type === technique,
      );
      add(
        `expected:${expected.target}/${technique}`,
        !!animation || !!expression,
      );
      if (expected.startFrame !== undefined && animation)
        add(
          `start:${expected.target}/${technique}`,
          animation.startFrame === expected.startFrame,
        );
      if (expected.amplitudeFactor !== undefined && expression) {
        const old = before.expressions?.find(
          (e) => e.expressionId === expression.expressionId,
        );
        add(
          `relative:${expected.target}`,
          !!old &&
            expression.parameters.amplitude ===
              old.parameters.amplitude * expected.amplitudeFactor,
        );
      }
    }
  }
  return checks;
}
