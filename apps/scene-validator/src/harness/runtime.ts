import { retainRuns } from "./retention.js";
import type { MetricRun } from "./metrics.js";
import { redact } from "./security.js";
import { readFile, readdir, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LoadedProject } from "../types.js";
import { atomicJson, noSymlinkPath, safeDirectory } from "../files.js";
import { harnessConfig, type HarnessConfig } from "./config.js";
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
} from "./providers/types.js";
import { saveExperience } from "./experience.js";
import { digest } from "./context.js";
export class BudgetError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export class HarnessRun {
  readonly started = performance.now();
  readonly controller = new AbortController();
  readonly signal: AbortSignal;
  readonly createdAt = new Date().toISOString();
  calls: {
    purpose?: ProviderRequest["purpose"];
    requestBytes?: {
      messages: number;
      schema: number;
      system: number;
      user: number;
    };
    provider: string;
    mode: "live" | "mock";
    model: string;
    latencyMs: number;
    usage: ProviderResponse["usage"];
    cost: number | null;
    status: string;
    diagnostics?: string[];
  }[] = [];
  events: { stage: string; at: string; durationMs: number; data: unknown }[] =
    [];
  references: unknown[] = [];
  techniques: string[] = [];
  failures: string[] = [];
  renderedFrames = 0;
  repairAttempts = 0;
  qaDurationMs = 0;
  renderDurationMs = 0;
  cacheHits = 0;
  cacheMisses = 0;
  contextBytes = 0;
  firstPreviewAvailableMs: number | null = null;
  sampledPeakRSS = process.memoryUsage().rss;
  private timer: ReturnType<typeof setTimeout>;
  private memoryTimer: ReturnType<typeof setInterval>;
  private finished = false;
  private repairStarted: number | undefined;
  private constructor(
    readonly project: LoadedProject,
    readonly runId: string,
    readonly config: HarnessConfig,
    readonly directory: string,
    readonly scratch: boolean,
    external?: AbortSignal,
  ) {
    this.signal = AbortSignal.any([
      this.controller.signal,
      ...(external ? [external] : []),
    ]);
    this.timer = setTimeout(
      () => this.controller.abort(new BudgetError("EXECUTION_TIMEOUT")),
      config.maxDurationMs,
    );
    this.timer.unref();
    this.memoryTimer = setInterval(
      () =>
        (this.sampledPeakRSS = Math.max(
          this.sampledPeakRSS,
          process.memoryUsage().rss,
        )),
      500,
    );
    this.memoryTimer.unref();
  }
  static async start(
    project: LoadedProject,
    runId: string,
    request: string,
    provider: string,
    model: string,
    signal?: AbortSignal,
    override?: Partial<HarnessConfig>,
  ) {
    const config = await harnessConfig(project.root, override);
    const directory =
      config.privacy === "full"
        ? await safeDirectory(project.root, `motion/ai/${runId}`)
        : await mkdtemp(path.join(tmpdir(), "motion-harness-private-"));
    const run = new HarnessRun(
      project,
      runId,
      config,
      directory,
      config.privacy !== "full",
      signal,
    );
    try {
      await run.record("received", { request, provider, model });
      await run.persist("RUNNING");
      return run;
    } catch (error) {
      await run.finish("FAILED");
      throw error;
    }
  }
  checkpoint() {
    if (this.signal.aborted)
      throw this.signal.reason instanceof BudgetError
        ? this.signal.reason
        : new BudgetError("CANCELLED");
    if (performance.now() - this.started > this.config.maxDurationMs)
      throw new BudgetError("EXECUTION_TIMEOUT");
  }
  async record(stage: string, data: unknown) {
    this.checkpoint();
    await this.diagnostic(stage, data);
  }
  async diagnostic(stage: string, data: unknown) {
    this.events.push({
      stage,
      at: new Date().toISOString(),
      durationMs: performance.now() - this.started,
      data: this.config.privacy === "full" ? data : { details: "redacted" },
    });
    await this.persist("RUNNING");
  }
  async invoke(adapter: ProviderAdapter, request: ProviderRequest) {
    this.checkpoint();
    if (this.calls.length >= this.config.maxLLMCalls)
      throw new BudgetError("LLM_CALL_BUDGET");
    if (
      Buffer.byteLength(request.messages.map((m) => m.content).join("")) >
      this.config.maxContextBytes
    )
      throw new BudgetError("CONTEXT_BUDGET");
    const known = this.calls.reduce((n, c) => n + (c.cost ?? 0), 0);
    if (
      this.config.maxEstimatedCost !== null &&
      known >= this.config.maxEstimatedCost
    )
      throw new BudgetError("COST_BUDGET");
    const now = performance.now();
    const purpose = request.purpose ?? "motion-repair";
    const semantic = purpose.startsWith("semantic");
    if (!semantic && this.repairStarted === undefined) this.repairStarted = now;
    const phaseRemaining = semantic
      ? this.config.semanticPlanningTimeoutMs - (now - this.started)
      : this.config.repairBudgetMs - (now - this.repairStarted!);
    const totalRemaining = this.config.maxDurationMs - (now - this.started);
    const available = Math.min(phaseRemaining, totalRemaining);
    const completed = this.calls.filter((c) => c.status === "SUCCESS");
    const estimated = Math.max(
      this.config.minimumRetryBudgetMs,
      ...completed.map((c) => c.latencyMs * 1.05),
    );
    if (
      available <= 0 ||
      (this.calls.length > 0 &&
        available < estimated + this.config.executionReserveMs)
    ) {
      const code = semantic ? "SEMANTIC_TIME_BUDGET" : "REPAIR_TIME_BUDGET";
      await this.record("provider-call-skipped", {
        code,
        purpose,
        availableMs: available,
        estimatedCallMs: estimated,
        reserveMs: this.config.executionReserveMs,
      });
      throw new BudgetError(code);
    }
    const timeoutMs = Math.max(
      1,
      Math.floor(Math.min(request.timeoutMs, available)),
    );
    const call = {
      purpose,
      requestBytes: {
        messages: Buffer.byteLength(
          request.messages.map((m) => m.content).join(""),
        ),
        schema: Buffer.byteLength(JSON.stringify(request.responseSchema)),
        system: Buffer.byteLength(
          request.messages
            .filter((m) => m.role === "system")
            .map((m) => m.content)
            .join(""),
        ),
        user: Buffer.byteLength(
          request.messages
            .filter((m) => m.role === "user")
            .map((m) => m.content)
            .join(""),
        ),
      },
      provider: adapter.id,
      mode: adapter.mode,
      model: request.model ?? "provider-default",
      latencyMs: 0,
      usage: null as ProviderResponse["usage"],
      cost: null as number | null,
      status: "RUNNING",
      diagnostics: [] as string[],
    };
    this.calls.push(call);
    const start = performance.now();
    await this.record("provider-started", {
      callIndex: this.calls.length,
      provider: adapter.id,
      model: call.model,
      purpose,
      timeoutMs,
      availableMs: available,
      requestBytes: call.requestBytes,
    });
    try {
      const limit = AbortSignal.any([
        this.signal,
        AbortSignal.timeout(timeoutMs),
      ]);
      const pending = adapter.generate({
        ...request,
        timeoutMs,
        signal: limit,
      });
      const result = await abortable(pending, limit);
      if (result.toolCalls.length)
        throw new BudgetError("UNSUPPORTED_TOOL_CALL");
      call.usage = result.usage;
      call.cost = result.estimatedCost;
      call.diagnostics = result.diagnostics;
      call.status = "SUCCESS";
      if (
        result.usage &&
        result.usage.outputTokens > this.config.maxOutputTokens
      )
        throw new BudgetError("OUTPUT_TOKEN_BUDGET");
      if (
        this.config.maxEstimatedCost !== null &&
        result.estimatedCost !== null &&
        known + result.estimatedCost > this.config.maxEstimatedCost
      )
        throw new BudgetError("COST_BUDGET");
      this.checkpoint();
      return result;
    } catch (e) {
      call.status = String(e);
      throw e;
    } finally {
      call.latencyMs = performance.now() - start;
      this.events.push({
        stage: "provider-completed",
        at: new Date().toISOString(),
        durationMs: performance.now() - this.started,
        data: {
          callIndex: this.calls.length,
          provider: adapter.id,
          status: call.status,
          latencyMs: call.latencyMs,
          usage: call.usage,
        },
      });
      await this.persist("RUNNING");
    }
  }
  providerRuntime() {
    return {
      invoke: this.invoke.bind(this),
      signal: this.signal,
      providerTimeoutMs: this.config.providerTimeoutMs,
      maxOutputTokens: this.config.maxOutputTokens,
    };
  }
  beforeRender() {
    this.checkpoint();
    if (this.renderedFrames >= this.config.maxRenderedQAFrames) {
      this.controller.abort(new BudgetError("QA_FRAME_BUDGET"));
      throw new BudgetError("QA_FRAME_BUDGET");
    }
    this.renderedFrames++;
  }
  private root() {
    return `motion/harness/runs/${this.runId}`;
  }
  async persist(status: string, result?: unknown) {
    if (this.config.privacy === "off") return;
    const dir = await safeDirectory(this.project.root, this.root());
    const usage = this.calls.every((c) => c.usage !== null)
      ? {
          inputTokens: this.calls.reduce((n, c) => n + c.usage!.inputTokens, 0),
          outputTokens: this.calls.reduce(
            (n, c) => n + c.usage!.outputTokens,
            0,
          ),
          cachedInputTokens: this.calls.every(
            (c) => typeof c.usage?.cachedInputTokens === "number",
          )
            ? this.calls.reduce((n, c) => n + c.usage!.cachedInputTokens!, 0)
            : null,
        }
      : null;
    const cost =
      this.calls.length && this.calls.every((c) => c.cost !== null)
        ? this.calls.reduce((n, c) => n + c.cost!, 0)
        : null;
    await atomicJson(
      path.join(dir, "run.json"),
      redact({
        schemaVersion: "1.0.0",
        runId: this.runId,
        projectId: this.project.config.projectId,
        ownerPid: process.pid,
        sourceFingerprint: this.project.inspection.fingerprint,
        createdAt: this.createdAt,
        status,
        privacy: this.config.privacy,
        config: this.config,
        outcome: outcome(result),
        knowledgeReferences: this.references,
        selectedTechniques: this.techniques,
        calls: this.calls.map((c) => ({
          ...c,
          status: /SUCCESS|RUNNING/.test(c.status)
            ? c.status
            : this.config.privacy === "full"
              ? c.status
              : "FAILED",
        })),
        metrics: {
          llmCalls: this.calls.length,
          usage,
          estimatedCost: cost,
          latencyMs: performance.now() - this.started,
          qaDurationMs: this.qaDurationMs,
          renderDurationMs: this.renderDurationMs,
          renderedQAFrames: this.renderedFrames,
          repairAttempts: this.repairAttempts,
          cacheHits: this.cacheHits,
          cacheMisses: this.cacheMisses,
          cacheHitRate:
            this.cacheHits + this.cacheMisses
              ? this.cacheHits / (this.cacheHits + this.cacheMisses)
              : null,
          contextBytes: this.contextBytes,
          timeToFirstPreviewMs: null,
          firstPreviewAvailableMs: this.firstPreviewAvailableMs,
          sampledPeakRSS: this.sampledPeakRSS,
        },
        artisticQuality: "NOT_TESTED",
        failures: this.failures,
        result:
          this.config.privacy === "full"
            ? result
            : result
              ? { details: "redacted" }
              : undefined,
      }),
    );
    await atomicJson(path.join(dir, "trace.json"), redact(this.events));
  }
  async finish(
    status: string,
    result?: {
      reconciliation?: unknown;
      requirements?: {
        techniques: string[];
        status: string;
        error?: string;
        qaResult?: unknown;
      }[];
      tasks?: { repairHistory?: unknown[] }[];
    },
    request?: string,
  ) {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timer);
    clearInterval(this.memoryTimer);
    this.techniques = [
      ...new Set(
        result?.requirements?.flatMap((r) => r.techniques) ?? this.techniques,
      ),
    ];
    this.failures = [
      ...new Set([
        ...this.failures,
        ...(result?.requirements
          ?.filter((r) => r.status !== "PASSED")
          .map((r) => r.error?.split(":")[0] ?? r.status) ?? []),
      ]),
    ];
    this.repairAttempts =
      result?.tasks?.reduce(
        (n, t) =>
          n +
          Math.max(
            0,
            ...(t.repairHistory ?? []).map(
              (h) => ((h as { attempt?: number }).attempt ?? 1) - 1,
            ),
          ),
        0,
      ) ?? this.repairAttempts;
    try {
      this.events.push({
        stage: "run-finished",
        at: new Date().toISOString(),
        durationMs: performance.now() - this.started,
        data: { status },
      });
      await this.persist(status, result);
      if (this.config.privacy !== "off")
        await saveExperience(this.project.root, {
          runId: this.runId,
          createdAt: this.createdAt,
          status,
          request: this.config.privacy === "full" ? request : undefined,
          techniques: this.techniques,
          failures: this.failures,
          repairs: this.repairAttempts,
          objectiveQA: result?.requirements?.length
            ? result.requirements.some(
                (r) => (r.qaResult as { status?: string })?.status === "FAILED",
              )
              ? "FAILED"
              : result.requirements.some(
                    (r) => !(r.qaResult as { status?: string })?.status,
                  )
                ? "PARTIAL_OR_NOT_TESTED"
                : result.requirements.some(
                      (r) =>
                        (r.qaResult as { status?: string })?.status ===
                        "WARNING",
                    )
                  ? "WARNING"
                  : "PASSED"
            : "NOT_TESTED",
          artisticQuality: "NOT_TESTED",
          versions: this.references,
        });
      if (!this.scratch && this.config.privacy !== "off") {
        // Retention failures do not roll back a completed motion edit.
        await retainRuns(
          this.project.root,
          {
            maxRuns: this.config.historyMaxRuns,
            maxAgeDays: this.config.historyMaxAgeDays,
            maxBytes: this.config.historyMaxBytes,
          },
          this.runId,
        ).catch((error) => {
          console.warn("Harness retention:", String(error));
        });
      }
    } finally {
      if (this.scratch) {
        await rm(this.directory, { recursive: true, force: true });
        await rm(path.join(this.project.root, `motion/qa/${this.runId}`), {
          recursive: true,
          force: true,
        });
      }
    }
  }
}
export async function readRuns(root: string) {
  const dir = path.join(root, "motion/harness/runs");
  try {
    await noSymlinkPath(root, dir);
    const files = (await readdir(dir)).filter((f) => /^[a-f0-9-]{36}$/.test(f));
    return await Promise.all(
      files.map(async (f) => {
        const file = path.join(dir, f, "run.json");
        await noSymlinkPath(root, file);
        return JSON.parse(await readFile(file, "utf8")) as Record<
          string,
          unknown
        > &
          MetricRun;
      }),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
export async function recoverInterruptedRuns(root: string) {
  for (const r of await readRuns(root))
    if (r.status === "RUNNING" && r.ownerPid !== process.pid) {
      await atomicJson(
        path.join(root, "motion/harness/runs", String(r.runId), "run.json"),
        {
          ...r,
          status: "INTERRUPTED",
          recovery:
            "Last validated Motion State remains persisted; generation is not resumed automatically",
        },
      );
    }
}

export function abortable<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new BudgetError("CANCELLED"),
      );
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function outcome(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const v = value as {
    reconciliation?: unknown;
    requirements?: {
      status: string;
      checks?: { name: string; status: string }[];
      qaResult?: { status: string };
    }[];
  };
  const checks =
    v.requirements
      ?.flatMap((r) => r.checks ?? [])
      .filter((c) => c.name === "requiredTechnique") ?? [];
  return {
    reconciliation: v.reconciliation ?? null,
    techniqueChecks: {
      passed: checks.filter((c) => c.status === "PASSED").length,
      total: checks.length,
    },
    qaRecorded: v.requirements?.filter((r) => r.qaResult?.status).length ?? 0,
  };
}
