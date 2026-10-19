import { renderingMode } from "../native/client.js";
import { qaAdmission } from "./qa/policy.js";
import { selectorContext } from "../harness/selector-context.js";
import {
  loadProviderSettings,
  saveProviderSettings,
  parseProviderSettings,
  ProviderSettingsError,
} from "./provider-settings.js";
import { providerIds } from "../harness/providers/index.js";
import { redact, redactSecrets } from "../harness/security.js";
import { HarnessRun } from "../harness/runtime.js";
import { digest, agentContext } from "../harness/context.js";
import { recentSuccessfulActions } from "./contextual-resolution.js";
import { RunQA } from "../harness/qa.js";
import type { HarnessConfig } from "../harness/config.js";
import { semanticPlan, SemanticCodexProvider } from "./intent/planner.js";
import { preflightIntentPlan, runIntentTasks } from "./intent/execution.js";
import { motionQA, stateDigest } from "./qa/render.js";
import {
  intentRequirements,
  validateTechnique,
  MotionFailure,
} from "./qa/technical.js";
import { mentionSchema, validateMentions } from "./mentions.js";
import { motionKnowledge } from "../motion-library/knowledge.js";
import { ensureRegistry } from "./registry.js";
import { transitionDiagnostics } from "./transitions.js";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  atomicJson as originalAtomicJson,
  noSymlinkPath,
  safeDirectory,
} from "../files.js";
import type { LoadedProject } from "../types.js";
import { readOptional } from "../management.js";
import { readMotion, changeMotion } from "./store.js";
import { buildContext, objectsIn } from "./context.js";
import { applyOperations, motionDiff } from "./operations.js";
import { parsePlan } from "./schema.js";
import {
  CodexProvider,
  providerSettingsSchema,
  plannerInstructions,
  outputSchema,
} from "./provider.js";
import { resolveTarget, runAutonomous } from "./autonomy.js";
const atomicJson = (file: string, value: unknown) =>
  originalAtomicJson(file, redact(value));
export const requestSchema = z
  .object({
    mode: z.enum(["create", "edit"]),
    request: z.string().min(1).max(20000),
    mentions: z.array(mentionSchema).max(100).default([]),
    selectedObjectId: z.string().max(180).optional(),
    selectedObjectIds: z.array(z.string().max(180)).max(200).optional(),
    selectedSceneId: z.string().max(180).optional(),
    activeSceneId: z.string().max(180).optional(),
    settings: providerSettingsSchema,
    expectedRevision: z.string(),
  })
  .strict();
export async function projectMotion(project: LoadedProject) {
  const document = await readMotion(project);
  let provider: Awaited<ReturnType<typeof loadProviderSettings>> | undefined;
  let providerSettingsError: ProviderSettingsError | undefined;
  try {
    provider = await loadProviderSettings(project);
  } catch (error) {
    if (!(error instanceof ProviderSettingsError)) throw error;
    providerSettingsError = error;
  }
  const registry = await ensureRegistry(project);
  return {
    document,
    renderer:renderingMode(),
    registry,
    diagnostics: [
      ...(document.sourceDiagnostics ?? []),
      ...(() => {
        try {
          return transitionDiagnostics(document.state, project);
        } catch (e) {
          return [String(e)];
        }
      })(),
    ],
    objects: project.inspection.document.scenes.flatMap(objectsIn).map((o) => {
      const logical = registry.objects.find((l) =>
        l.sourceInstances.some(
          (i) => i.sourceNodeId === o.targetId && i.sceneId === o.sceneId,
        ),
      );
      return {
        ...o,
        logicalObjectId: logical?.logicalObjectId,
        stateCount: logical?.states.length ?? 0,
        ambiguous: logical?.ambiguousScenes.includes(o.sceneId) ?? false,
      };
    }),
    scenes: project.inspection.document.scenes.map((s) => ({
      sceneId: s.sceneId,
      name: s.name,
      width: s.width,
      height: s.height,
    })),
    availableProviders: providerIds(),
    provider: provider?.settings ?? null,
    providerSettingsSource: provider?.source ?? "persisted-invalid",
    providerSettingsError: providerSettingsError
      ? {
          message: providerSettingsError.message,
          ...providerSettingsError.diagnostic,
        }
      : undefined,
  };
}
export async function prepareMotionRequest(
  project: LoadedProject,
  input: unknown,
  onSource?: (source: string) => void,
) {
  const raw =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  try {
    const loaded =
      raw.settings === undefined
        ? await loadProviderSettings(project)
        : undefined;
    const settings =
      loaded?.settings ?? parseProviderSettings(raw.settings, "api");
    onSource?.(loaded?.source ?? "api");
    return requestSchema.parse({ ...raw, settings });
  } catch (error) {
    if (error instanceof ProviderSettingsError) {
      const run = await HarnessRun.start(
        project,
        randomUUID(),
        typeof raw.request === "string"
          ? raw.request.slice(0, 20000)
          : "[provider settings validation]",
        null,
        "",
      );
      run.failures.push(error.code);
      try {
        await run.diagnostic("provider-settings-validation", error.diagnostic);
      } finally {
        await run.finish("FAILED");
      }
    }
    throw error;
  }
}
export async function proposeMotion(
  project: LoadedProject,
  input: unknown,
  onStage: (stage: string) => void = () => {},
  execute = false,
  options: {
    signal?: AbortSignal;
    config?: Partial<HarnessConfig>;
    evalContext?: { evalId: string; datasetVersion: string };
  } = {},
) {
  let settingsSource = "api";
  const request = await prepareMotionRequest(project, input, (source) => {
      settingsSource = source;
    }),
    doc = await readMotion(project);
  if (doc.revision !== request.expectedRevision)
    throw new Error("Анимация изменилась до запроса. Обновите страницу.");
  const savedSettings = await saveProviderSettings(
    project,
    request.settings,
    "execution",
  );
  const id = randomUUID();
  const harness =
    execute && request.settings.provider !== "manual-response"
      ? await HarnessRun.start(
          project,
          id,
          request.request,
          request.settings.provider,
          request.settings.model,
          options.signal,
          options.config,
        )
      : undefined;
  let runQA: RunQA | undefined;
  const directory =
    harness?.directory ??
    (await safeDirectory(project.root, `motion/ai/${id}`));
  const providerDirectory = async (relative: string) => {
    const dir = path.join(directory, relative);
    await mkdir(dir, { recursive: true });
    return dir;
  };
  try {
    const recent = [
      ...new Map(
        doc.history.slice(0, doc.cursor).map((h) => {
          const run = h.request.match(/^\[([a-f0-9-]{36})\//)?.[1];
          return [
            run ?? h.editId,
            {
              request: h.request.replace(/^\[[^\]]+\]\s*/, ""),
              assumptions: h.assumptions,
              selectedObjectId: undefined as string | undefined,
              selectedSceneId: undefined as string | undefined,
            },
          ];
        }),
      ).values(),
    ].slice(-4);
    request.mentions = validateMentions(
      project,
      request.request,
      request.mentions,
    );
    let resolution: ReturnType<typeof resolveTarget> | undefined;
    let enrichedContext: Record<string, unknown>;
    const sceneTimingHint =
      /(?:сцен|scene)[\s\S]{0,70}(?:начина|начн|starts|\bна\s*\d+\s*(?:кадр|сек)|\bat\s*\d+\s*(?:frame|second))/iu.test(
        request.request,
      );
    const lifecycleEditHint =
      /убер|удал|remove|delete|быстр|направлен|наоборот|от конца|reverse/iu.test(
        request.request,
      ) &&
      /trim|прорис|fade|фейд|slide|инерц|колеб/iu.test(request.request) &&
      !/появ|добав|создай/iu.test(request.request);
    const timingEditHint =
      doc.state.animations.length > 0 &&
      /начина|начн|после|законч|start|after|before|одновременно|кадр/iu.test(
        request.request,
      ) &&
      !/создай|добав|появ|зааним|анимируй|animate|прорис/iu.test(
        request.request,
      );
    const contextualEditHint =
      !sceneTimingHint &&
      (timingEditHint ||
        lifecycleEditHint ||
        ((/колеб|инерц|амплитуд/iu.test(request.request) ||
          (recentSuccessfulActions(doc).length > 0 &&
            request.request.length < 120)) &&
          /слаб|силь|уменьш|убер/iu.test(request.request) &&
          !/добав|появ|движ|позици|создай|изинг|easing|фейд|fade|trim|масштаб|ключ/iu.test(
            request.request,
          )));
    const selectedContext = harness
      ? contextualEditHint
        ? await selectorContext(project, doc, request, recent, harness.config)
        : await agentContext(
            project,
            doc.state,
            request,
            recent,
            harness.config,
          )
      : undefined;
    if (selectedContext) enrichedContext = selectedContext.value;
    else {
      resolution = resolveTarget(project, doc.state, request, recent);
      const context = buildContext(
        project,
        doc.state,
        request.request,
        resolution.target.targetId,
        resolution.target.sceneId,
      );
      enrichedContext = {
        ...context,
        motionKnowledge: await motionKnowledge(
          request.request,
          resolution.target.type === "TEXT",
        ),
        mentions: request.mentions,
        runtimeTarget: resolution.target,
        runtimeTargetIsExplicit: Boolean(
          request.selectedObjectId || request.mentions.length,
        ),
        runtimeAssumptions: resolution.assumptions,
        activeSceneId: request.activeSceneId ?? resolution.target.sceneId,
        recentConversation: recent,
        appliedHistory: doc.history
          .slice(0, doc.cursor)
          .slice(-8)
          .map((h) => ({ request: h.request, operations: h.operations })),
      };
    }
    enrichedContext.recentSuccessfulActions ??= recentSuccessfulActions(
      doc,
    ).slice(0, 5);
    enrichedContext.projectRevision = doc.revision;
    enrichedContext.selectedObjectIds =
      request.selectedObjectIds ??
      (request.selectedObjectId ? [request.selectedObjectId] : []);
    enrichedContext.contextualEditHint = contextualEditHint;
    if (harness && selectedContext) {
      harness.references = [
        ...selectedContext.references,
        ...(options.evalContext
          ? [
              {
                id: "eval:" + options.evalContext.evalId,
                version: options.evalContext.datasetVersion,
              },
            ]
          : []),
      ];
      harness.contextBytes = selectedContext.bytes;
      if (selectedContext.cacheHit) harness.cacheHits++;
      else harness.cacheMisses++;
      await harness.record("context-built", {
        digest: selectedContext.contextDigest,
        bytes: selectedContext.bytes,
        references: selectedContext.references,
      });
    }
    await atomicJson(path.join(directory, "context.json"), enrichedContext);
    await safeDirectory(project.root, "motion/ai");
    if (harness)
      await harness.record("provider-settings", {
        source: settingsSource,
        providerInitializationStatus: "ADAPTER_READY",
        provider: request.settings.provider,
        persisted: savedSettings.persisted,
        reason: savedSettings.persisted
          ? "persistent live/manual selection"
          : "transient adapter: not written to project settings",
      });
    const basis = {
      id,
      request,
      revision: doc.revision,
      sourceFingerprint: project.inspection.fingerprint,
    };
    await atomicJson(path.join(directory, "request.json"), basis);
    if (request.settings.provider === "manual-response") {
      await writeFile(
        path.join(directory, "request.txt"),
        plannerInstructions + "\n" + JSON.stringify(enrichedContext),
      );
      await atomicJson(
        path.join(directory, "output-schema.json"),
        outputSchema,
      );
      return {
        ...basis,
        manual: true,
        prompt: plannerInstructions + "\n" + JSON.stringify(enrichedContext),
        schema: outputSchema,
      };
    }
    if (execute) {
      try {
        onStage("understanding");
        const semanticProvider = new SemanticCodexProvider(
          async (phase) =>
            new CodexProvider(
              request.settings,
              await providerDirectory(`semantic-${phase}`),
              harness?.providerRuntime(),
            ),
        );
        const contract = await semanticPlan(
          project,
          request.request,
          enrichedContext,
          semanticProvider,
          async (stage, value) => {
            if (
              harness &&
              (stage.startsWith("coverage") ||
                stage.startsWith("semantic-retry") ||
                stage.startsWith("failure") ||
                stage === "target-resolution" ||
                stage === "reference-context")
            )
              await harness.diagnostic(
                stage.startsWith("coverage")
                  ? "semantic-coverage"
                  : "semantic-diagnostic",
                {
                  phase: stage,
                  report: value,
                },
              );
            await atomicJson(
              path.join(directory, `intent-${stage}.json`),
              value,
            );
          },
          {
            auditAlways: false,
            recentActions: recentSuccessfulActions(doc, true),
            projectRevision: doc.revision,
            selectedObjectIds: request.selectedObjectIds,
            maxAttempts: harness?.config.maxLLMCalls ?? 3,
            motionState: doc.state,
            activeSceneId: request.activeSceneId,
            selectedObjectId: request.selectedObjectId,
          },
        );
        if (harness) {
          await harness.record("intent-plan", {
            requirements: contract.requirements,
          });
          runQA = new RunQA(harness);
        }
        if (
          contract.requirements.some(
            (r) => r.semanticActionId || r.effectOperation,
          )
        ) {
          try {
            const preflight = preflightIntentPlan(project, doc.state, contract);
            await atomicJson(
              path.join(directory, "compilation-preflight.json"),
              preflight,
            );
            await harness?.diagnostic("compilation-preflight", preflight);
          } catch (error) {
            await atomicJson(
              path.join(directory, "compilation-preflight.json"),
              (error as { report?: unknown }).report ?? {
                status: "FAILED",
                failure: String(error),
              },
            );
            await harness?.diagnostic(
              "compilation-preflight",
              (error as { report?: unknown }).report ?? { status: "FAILED" },
            );
            throw error;
          }
        }
        let committed = doc;
        const generated = await runIntentTasks(project, doc.state, contract, {
          repair: async (ctx, text, task, attempt) => {
            onStage("repairing");
            if (harness) harness.repairAttempts++;
            const provider = new CodexProvider(
              request.settings,
              await providerDirectory(`${task.taskId}/attempt-${attempt}`),
              harness?.providerRuntime(),
            );
            return provider.editMotionPlan(
              {
                ...enrichedContext,
                ...(ctx as object),
                requestScope: contract.requirements,
                taskScope: task,
                repairScope: {
                  requirementIds: task.requirementIds,
                  techniques: task.techniques,
                },
              },
              text,
            );
          },
          verify: async (task, next, before, attempt) => {
            onStage("checking");
            const qa = runQA
              ? await runQA.verify(task, next, before, attempt)
              : await motionQA(
                  project,
                  next,
                  `motion/qa/${id}/${task.taskId}-attempt-${attempt}`,
                  task.userIntent,
                  before,
                  task.kind === "sceneTiming"
                    ? undefined
                    : task.targetReference,
                );
            return qa;
          },
          commit: async (task, plan, next) => {
            await harness?.record("candidate-task-accepted", {
              taskId: task.taskId,
              operations: plan.operations,
              persisted: false,
            });
            return next;
          },
          checkpoint: () => harness?.checkpoint(),
          maxAttempts: 1 + (harness?.config.maxRepairAttempts ?? 2),
          trace: async (tasks, entry) => {
            if (harness && entry) {
              if ((entry as { status?: string }).status === "repair") {
                const error = (
                  entry as { feedback?: { failureReason?: string } }
                ).feedback?.failureReason;
                if (error) harness.failures.push(error.split(":")[0]);
              }
              await harness.record("task-trace", entry);
            }
            await atomicJson(path.join(directory, "tasks.json"), {
              runId: id,
              userIntent: request.request,
              contract,
              tasks,
              entry,
              updatedAt: new Date().toISOString(),
            });
          },
        });
        if (
          generated.requirements.some(
            (r) =>
              r.status === "FAILED" &&
              generated.tasks.find((t) => t.taskId === r.taskId)?.status ===
                "PASSED",
          )
        )
          throw new Error(
            "FINAL_RECONCILIATION_FAILED: candidate not committed",
          );
        await atomicJson(path.join(directory, "candidate-commit.json"), {
          runId: id,
          expectedRevision: doc.revision,
          sourceFingerprint: project.inspection.fingerprint,
          operationBatches: generated.operationBatches,
          reconciliation: generated.reconciliation,
          status: "PREPARED",
        });
        let durabilityWarning: string | undefined;
        if (generated.reconciliation.completed) {
          harness?.checkpoint();
          onStage("applying");
          const publication = await changeMotion(project.root, {
            expectedRevision: doc.revision,
            expectedSourceFingerprint: project.inspection.fingerprint,
            operationBatches: generated.operationBatches,
            expectedCandidate: generated.next,
            transactionId: id,
            request:
              harness && harness.config.privacy !== "full"
                ? `[${id}/run] request redacted`
                : `[${id}/run] ${redactSecrets(request.request)}`,
            origin: request.settings.provider,
            assumptions:
              harness && harness.config.privacy !== "full"
                ? []
                : redact(generated.plan.assumptions),
            warnings:
              harness && harness.config.privacy !== "full"
                ? []
                : redact(generated.plan.warnings),
          });
          committed = publication.document;
          durabilityWarning = publication.durabilityWarning;
          if (harness)
            harness.firstPreviewAvailableMs =
              performance.now() - harness.started;
        }
        const starts = generated.plan.operations.flatMap((op) =>
          op.type === "addAnimation" || op.type === "updateAnimation"
            ? [op.animation.startFrame]
            : op.type === "retimeScenes"
              ? op.starts.map((s) => s.startFrame)
              : [],
        );
        const result = {
          ...basis,
          plan: generated.plan,
          tasks: generated.tasks,
          requirements: generated.requirements,
          intentContract: contract,
          reconciliation: generated.reconciliation,
          status: generated.reconciliation.completed ? "applied" : "failed",
          document: committed,
          playbackStart: starts.length ? Math.min(...starts) : 0,
          taskExecution: true,
          persistence: {
            status: !generated.reconciliation.completed
              ? "NOT_COMMITTED"
              : durabilityWarning
                ? "DURABILITY_WARNING"
                : "CONFIRMED",
            warning: durabilityWarning,
          },
        };
        try {
          if (generated.reconciliation.completed)
            await atomicJson(path.join(directory, "commit-receipt.json"), {
              runId: id,
              receipt: committed.lastCommit,
              status: "COMMITTED",
              beforeStateDigest: stateDigest(doc.state),
              afterStateDigest: stateDigest(committed.state),
              changes: motionDiff(doc.state, committed.state).map((c) => ({
                path: c.path,
                beforeDigest: digest(c.before),
                afterDigest: digest(c.after),
              })),
            });
          await harness?.record("commit-result", {
            persisted: !!generated.reconciliation.completed,
            receipt: committed.lastCommit ?? null,
            revision: committed.revision,
          });
          await atomicJson(path.join(directory, "proposal.json"), result);
          await atomicJson(path.join(directory, "execution.json"), {
            runId: id,
            requirements: generated.requirements,
            reconciliation: generated.reconciliation,
            revision: committed.revision,
            appliedAt: new Date().toISOString(),
          });
          if (harness)
            await harness.finish(
              generated.reconciliation.status,
              generated,
              request.request,
            );
        } catch (error) {
          // Motion state + commit receipt is authoritative even if diagnostic storage fails.
          await harness
            ?.finish(
              generated.reconciliation.status,
              generated,
              request.request,
            )
            .catch(() => {});
          return {
            ...result,
            diagnosticPersistence: { status: "FAILED", reason: String(error) },
            commitReceipt: committed.lastCommit,
          };
        }
        return result;
      } catch (error) {
        await atomicJson(path.join(directory, "error.json"), {
          error: String(error),
          createdAt: new Date().toISOString(),
          stage: "semantic-execution",
        });
        throw error;
      }
    }
    try {
      const generated = await runAutonomous(
        project,
        doc.state,
        enrichedContext,
        request.request,
        async (ctx, text, attempt) => {
          const attemptDirectory = await safeDirectory(
            project.root,
            `motion/ai/${id}/attempt-${attempt}`,
          );
          const provider = new CodexProvider(
            request.settings,
            attemptDirectory,
          );
          return request.mode === "create"
            ? provider.generateMotionPlan(ctx, text)
            : provider.editMotionPlan(ctx, text);
        },
        async (entry, attempt) => {
          onStage(
            (entry as { status: string }).status === "repair"
              ? "repairing"
              : (entry as { status: string }).status === "checking"
                ? "checking"
                : "generating",
          );
          await atomicJson(
            path.join(directory, `attempt-${attempt}.json`),
            entry,
          );
        },
        async (next, attempt) => {
          onStage("checking");
          return motionQA(
            project,
            next,
            `motion/qa/${id}/attempt-${attempt}`,
            request.request,
            doc.state,
          );
        },
      );
      const plan = {
        ...generated.plan,
        warnings: [
          ...new Set([
            ...generated.plan.warnings,
            ...transitionDiagnostics(generated.next, project),
          ]),
        ].slice(0, 50),
        assumptions: [
          ...(resolution?.assumptions ?? []),
          ...generated.plan.assumptions,
        ],
      };
      const result = {
        ...basis,
        plan,
        attempts: generated.attempts,
        qa: generated.qa,
        requirements: generated.requirements,
        diff: motionDiff(doc.state, generated.next),
      };
      await atomicJson(path.join(directory, "proposal.json"), result);
      return result;
    } catch (error) {
      await atomicJson(path.join(directory, "error.json"), {
        error: String(error),
        createdAt: new Date().toISOString(),
      });
      throw error;
    }
  } catch (error) {
    if (harness) {
      harness.failures.push(String(error).split(":")[0]);
      await harness.finish(
        /CANCELLED/.test(String(error))
          ? "CANCELLED"
          : /TIMEOUT|timeout|aborted|TIME_BUDGET/i.test(String(error))
            ? "TIMEOUT"
            : "FAILED",
        undefined,
        request.request,
      );
    }
    throw error;
  } finally {
    await runQA?.close();
  }
}
export async function manualResponse(
  project: LoadedProject,
  id: string,
  response: unknown,
) {
  z.uuid().parse(id);
  const directory = path.join(project.root, "motion/ai", id);
  await noSymlinkPath(project.root, path.join(directory, "request.json"));
  const basis = JSON.parse(
    await readFile(path.join(directory, "request.json"), "utf8"),
  );
  const plan = parsePlan(response),
    doc = await readMotion(project);
  if (
    doc.revision !== basis.revision ||
    project.inspection.fingerprint !== basis.sourceFingerprint
  )
    throw new Error("Запрос устарел");
  if (plan.status !== "ready" || !plan.operations.length)
    throw new Error(
      `Не удалось выполнить движение: ${plan.summary}. Изменения не применены.`,
    );
  const next = applyOperations(doc.state, plan.operations, project);
  const context = JSON.parse(
    await readFile(path.join(directory, "context.json"), "utf8"),
  );
  const requirements = intentRequirements(
    project,
    doc.state,
    basis.request.request,
    context,
  );
  validateTechnique(next, requirements);
  const qa = await motionQA(
    project,
    next,
    `motion/qa/${id}/manual`,
    basis.request.request,
    doc.state,
  );
  if (qa.status === "FAILED") throw new MotionFailure(qa);
  const proposal = {
    ...basis,
    plan,
    qa,
    requirements,
    diff: motionDiff(doc.state, next),
  };
  await atomicJson(path.join(directory, "proposal.json"), proposal);
  return proposal;
}
export async function applyProposal(project: LoadedProject, id: string) {
  z.uuid().parse(id);
  const file = path.join(project.root, "motion/ai", id, "proposal.json");
  await noSymlinkPath(project.root, file);
  const proposal = JSON.parse(await readFile(file, "utf8"));
  const plan = parsePlan(proposal.plan);
  if (plan.status !== "ready" || !plan.operations.length)
    throw new Error(
      `Не удалось выполнить движение: ${plan.summary}. Изменения не применены.`,
    );
  if (project.inspection.fingerprint !== proposal.sourceFingerprint)
    throw new Error("Исходный дизайн изменился; создайте новый запрос");
  const current = await readMotion(project);
  if (current.revision !== proposal.revision)
    throw new Error("Анимация изменилась; запрос устарел");
  const candidate = applyOperations(current.state, plan.operations, project);
  if (
    !proposal.qa ||
    !qaAdmission(proposal.qa).accepted ||
    proposal.qa.stateDigest !== stateDigest(candidate)
  )
    throw new Error(
      "Отсутствует актуальная Motion QA; выполните запрос заново",
    );
  return changeMotion(project.root, {
    expectedRevision: proposal.revision,
    operations: plan.operations,
    request: proposal.request.request,
    origin: proposal.request.settings.provider,
    assumptions: plan.assumptions,
    warnings: plan.warnings,
  });
}

async function recentConversation(project: LoadedProject) {
  const root = path.join(project.root, "motion/ai");
  await noSymlinkPath(project.root, root);
  let names: string[] = [];
  try {
    names = (await readdir(root)).filter((n) => z.uuid().safeParse(n).success);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const entries = await Promise.all(
    names.map(async (name) => ({
      name,
      time: (await stat(path.join(root, name))).mtimeMs,
    })),
  );
  const recent = [];
  for (const { name } of entries
    .sort((a, b) => b.time - a.time)
    .slice(0, 8)
    .reverse()) {
    const file = path.join(root, name, "request.json");
    try {
      await noSymlinkPath(project.root, file);
      const request = JSON.parse(await readFile(file, "utf8"));
      const answer = await readOptional(
        project.root,
        `motion/ai/${name}/proposal.json`,
      );
      recent.push({
        request: request.request.request,
        selectedObjectId: request.request.selectedObjectId,
        selectedSceneId: request.request.selectedSceneId,
        ...(answer
          ? {
              summary: JSON.parse(answer).plan.summary,
              assumptions: JSON.parse(answer).plan.assumptions ?? [],
            }
          : {}),
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return recent;
}
export async function executeMotion(
  project: LoadedProject,
  input: unknown,
  onStage: (stage: string) => void = () => {},
  options: {
    signal?: AbortSignal;
    config?: Partial<HarnessConfig>;
    evalContext?: { evalId: string; datasetVersion: string };
  } = {},
) {
  onStage("generating");
  const result = await proposeMotion(project, input, onStage, true, options);
  if ("manual" in result || "taskExecution" in result) return result;
  return completeExecution(project, result.id, onStage);
}
export async function completeExecution(
  project: LoadedProject,
  id: string,
  onStage: (stage: string) => void = () => {},
) {
  z.uuid().parse(id);
  const file = path.join(project.root, "motion/ai", id, "proposal.json");
  await noSymlinkPath(project.root, file);
  const result = JSON.parse(await readFile(file, "utf8"));
  const plan = parsePlan(result.plan);
  if (plan.status !== "ready" || !plan.operations.length)
    throw new Error(
      `Не удалось выполнить движение: ${plan.summary}. Изменения не применены.`,
    );
  onStage("applying");
  const before = await readMotion(project);
  const { document } = await applyProposal(project, id);
  const changed = document.state.animations.filter(
    (a) =>
      JSON.stringify(a) !==
      JSON.stringify(
        before.state.animations.find(
          (old) => old.animationId === a.animationId,
        ),
      ),
  );
  const changedBlocks = document.state.blocks.filter(
    (b) =>
      JSON.stringify(b) !==
      JSON.stringify(
        before.state.blocks.find((old) => old.blockId === b.blockId),
      ),
  );
  const starts = [
    ...(document.state.objectTransitions ?? [])
      .filter(
        (t) =>
          JSON.stringify(t) !==
          JSON.stringify(
            before.state.objectTransitions?.find(
              (o) => o.transitionId === t.transitionId,
            ),
          ),
      )
      .map((t) => t.startFrame),
    ...(document.state.expressions ?? [])
      .filter(
        (e) =>
          JSON.stringify(e) !==
          JSON.stringify(
            before.state.expressions?.find(
              (o) => o.expressionId === e.expressionId,
            ),
          ),
      )
      .map((e) => e.startFrame),
    ...changed.map((a) => a.startFrame),
    ...changedBlocks.map((b) => b.startFrame),
  ];
  const playbackStart = starts.length ? Math.min(...starts) : 0;
  const completed = { ...result, status: "applied", document, playbackStart };
  await atomicJson(path.join(path.dirname(file), "execution.json"), {
    revision: document.revision,
    playbackStart,
    appliedAt: new Date().toISOString(),
  });
  return completed;
}
