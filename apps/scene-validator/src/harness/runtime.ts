import {providerAbortCode,ProviderError as NormalizedProviderError} from "./providers/types.js";
import {supervisorExperience,rememberSupervisor} from "./recovery/supervisor-memory.js";
import {GlobalFailureSupervisor} from "./recovery/supervisor.js";
import { collectImprovements } from "./improvements.js";
import { recoveryFailure } from "./recovery/failure.js";
import { failureDiagnostic, type FailureDiagnostic } from "./failure.js";
import { prepareProviderRequest } from "./providers/budget.js";
import { PROVIDER_ID_PATTERN } from "../provider-contract.js";
import { providerIds } from "./providers/index.js";
import { retainRuns } from "./retention.js";
import type { MetricRun } from "./metrics.js";
import { redact } from "./security.js";
import { readFile, readdir, rm, mkdtemp } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import type { LoadedProject } from "../types.js";
import { atomicJson, noSymlinkPath, safeDirectory } from "../files.js";
import { harnessConfig,harnessConfigSchema, type HarnessConfig } from "./config.js";
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
  readonly supervisor:GlobalFailureSupervisor;
  readonly recoverySignal:AbortSignal;
  readonly externalSignal?:AbortSignal;
  calls: {
    purpose?: ProviderRequest["purpose"];
    inputBudget?: ReturnType<typeof prepareProviderRequest>["budget"];
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
  executionRole: 'direct'|'production'|'worker' = 'direct';
  productionId?: string;
  directCheckpointId?:string;
  references: unknown[] = [];
  techniques: string[] = [];
  failures: string[] = [];
  phase = "initialization";
  providerInitializationStatus = "NOT_STARTED";
  failure: FailureDiagnostic | undefined;
  async captureFailure(error: unknown) {
    if (this.finished) return;
    this.failure = failureDiagnostic(
      error,
      this.phase,
      this.providerInitializationStatus,
      this.config.privacy === "full",
    );
    if(!this.supervisor.report.events.length)await this.supervisor.settle(error,this.failure.failureStage,{}, {evidence:[{stack:this.failure.safeStackTrace}]});
    const last=this.supervisor.report.events.at(-1),root=this.supervisor.report.events.find(e=>e.id===last?.rootEventId);
    if(root&&this.config.privacy==="full"){this.failure.originalFailure={stage:root.stage,code:root.errorCode,invariant:root.rootCause};this.failure.causalChain=this.supervisor.report.events.filter(e=>e.rootEventId===root.id).map(e=>({eventId:e.id,parentEventId:e.parentEventId,rootEventId:e.rootEventId,code:e.errorCode,stage:e.stage}));}
    await this.diagnostic("structured-failure", recoveryFailure(error, this.phase, "unknown"));
    this.failures.push(this.failure.errorCode);
    await this.diagnostic("run-failed", this.failure);
    if (this.config.privacy === "full")
      await atomicJson(path.join(this.directory, "error.json"), this.failure);
  }
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
    this.externalSignal=external;
    this.recoverySignal=external??new AbortController().signal;
    this.supervisor=new GlobalFailureSupervisor({
      request:"",revision:"unknown",reserveSourceAttempt:config.recovery.codeRepair.enabled,maxAttempts:config.recovery.supervisorMaxAttempts,maxDurationMs:config.recovery.supervisorMaxDurationMs,signal:external,
      resources:()=>({primaryCalls:this.calls.filter(c=>!c.purpose?.includes("recovery")&&c.purpose!=="code-repair").length,recoveryCalls:this.calls.filter(c=>c.purpose?.includes("recovery")).length,codeInvestigationCalls:this.calls.filter(c=>c.purpose==="code-repair").length,maxPrimaryCalls:this.agentExecution?null:config.maxLLMCalls,projectRecoveryAttempts:config.recovery.maxAttempts,codeInvestigationEnabled:config.recovery.codeRepair.enabled}),
      known:async fingerprint=>(await supervisorExperience(project.root)).filter(r=>r.fingerprint===fingerprint&&r.codeVersion===digest(this.references)&&r.status==="VERIFIED").map(r=>({strategy:r.strategy,procedure:r.procedure,validation:r.validation})),
      trace:()=>this.events.slice(-12).map(e=>({stage:e.stage,at:e.at,durationMs:e.durationMs})),
      persist:async report=>{await this.diagnostic("global-recovery",{status:report.status,latestFailure:report.events.at(-1)?.errorCode,eventCount:report.events.length,attemptCount:report.attempts.length,reason:report.finalReason});if(config.privacy==="full")await atomicJson(path.join(directory,"global-recovery.json"),redact(report));},
    });
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
    provider: string | null,
    model: string,
    signal?: AbortSignal,
    override?: Partial<HarnessConfig>,
  ) {
    let config:HarnessConfig,startupError:unknown;
    try{config=await harnessConfig(project.root,override);}catch(error){config=harnessConfigSchema.parse({});startupError=error;}
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
      run.supervisor.setRequest(request);
      if(startupError){run.phase="harness-configuration";throw startupError;}
      await run.record("received", { request, provider, model });
      await run.persist("RUNNING");
      return run;
    } catch (error) {
      await run.captureFailure(error);
      await run.finish("FAILED");
      throw error;
    }
  }
  recoveryCheckpoint(){
    if(this.recoverySignal.aborted)throw Error("CANCELLED");
    if(this.repairStarted!==undefined&&performance.now()-this.repairStarted>this.config.recovery.maxDurationMs)throw Error("RECOVERY_TIME_BUDGET");
  }
  private agentExecution = false;
  enableAgentExecution() { this.agentExecution = true; clearTimeout(this.timer); }
  checkpoint() {
    if (this.signal.aborted)
      throw this.signal.reason instanceof BudgetError
        ? this.signal.reason
        : new BudgetError("CANCELLED");
    if (!this.agentExecution && performance.now() - this.started > this.config.maxDurationMs)
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
  async invoke(adapter: ProviderAdapter, request: ProviderRequest, transportRetried = false): Promise<ProviderResponse> {
    this.phase = "provider-startup";
    this.providerInitializationStatus = "ADAPTER_READY";
    const reservedRecovery=request.purpose==="semantic-recovery"||request.purpose==="project-recovery";
    if(reservedRecovery){if(this.recoverySignal.aborted)throw Error("CANCELLED");}
    else this.checkpoint();
    if (
      !PROVIDER_ID_PATTERN.test(adapter.id) ||
      (adapter.mode === "live" && !providerIds().includes(adapter.id))
    )
      throw new BudgetError("PROVIDER_NOT_REGISTERED");
    const purpose = request.purpose ?? "motion-repair";
    const isAgent=purpose==="agent-execution";
    const semantic = purpose.startsWith("semantic") && purpose!=="semantic-recovery";
    const isCodeRepair = purpose.startsWith("code-repair");
    const isRecovery = purpose.includes("recovery");
    const semanticCalls = this.calls.filter((c) =>
      (c.purpose ?? "").startsWith("semantic") && c.purpose!=="semantic-recovery",
    ).length;
    const repairCalls = this.calls.filter(
      (c) =>
        (c.purpose ?? "").includes("repair") ||
        (c.purpose ?? "").includes("recovery"),
    ).length;
    if (semantic && semanticCalls >= this.config.maxLLMCalls)
      throw new BudgetError("LLM_CALL_BUDGET");
    if (
      !semantic &&
      !isAgent &&
      !isCodeRepair &&
      repairCalls >=
        (this.config.recovery?.maxAttempts ??
          this.config.maxRepairAttempts ??
          3)
    )
      throw new BudgetError("RECOVERY_PROVIDER_BUDGET");
    if (this.calls.filter(c=>!c.purpose?.includes("recovery")).length >= this.config.maxLLMCalls && !isRecovery && !isCodeRepair && !isAgent)
      throw new BudgetError("LLM_CALL_BUDGET");
    if (
      !isAgent && this.calls.length >=
      this.config.maxLLMCalls + (this.config.recovery?.maxAttempts ?? 3) + 2
    )
      throw new BudgetError("LLM_CALL_BUDGET");
    let profiles=this.config.modelProfiles;
    if(!profiles.some(p=>p.provider===adapter.id&&p.model===(request.model??''))&&adapter.contextProfile){
      const discovered=await adapter.contextProfile(request.model);
      if(discovered){request={...request,model:discovered.model};profiles=[...profiles,discovered];}
    }
    let admission: ReturnType<typeof prepareProviderRequest>;
    try {
      admission=prepareProviderRequest(adapter,request,this.config.maxContextBytes,profiles);
    }catch(error){
      const report=(error as {contextAdmission?:unknown}).contextAdmission;
      if(report){await this.diagnostic("context-admission",{purpose,...report as object,llmCalls:this.calls.length});await this.supervisor.observe(error,"context-admission",{evidence:[report]});}
      throw error;
    }
    const {budget}=admission;
    request=admission.request;
    await this.diagnostic("context-admission",{purpose,...admission.report,llmCalls:this.calls.length});
    if(admission.report.compactedCategories.length){
      const event=await this.supervisor.observe(Object.assign(Error("CONTEXT_EXHAUSTED before lossless packing"),{code:"CONTEXT_EXHAUSTED"}),"context-admission",{evidence:[admission.report]});
      await this.supervisor.attempt(event,{strategy:"deterministic",procedure:"lossless-context-packing/1",reason:"Full request was safely repacked before any provider call",run:async()=>admission.report,verify:async r=>{if(r.status!=="ADMITTED")throw Error("CONTEXT_ADMISSION_FAILED");return {status:"PASSED",before:r.beforeBytes,after:r.afterBytes,budget:r.budgetBytes,lossless:true};}});
    }
    request = { ...request, maxOutputTokens: budget.outputTokens };
    const known = this.calls.reduce((n, c) => n + (c.cost ?? 0), 0);
    if (
      !isAgent && this.config.maxEstimatedCost !== null &&
      known >= this.config.maxEstimatedCost
    )
      throw new BudgetError("COST_BUDGET");
    const now = performance.now();
    if (!semantic && !isAgent && this.repairStarted === undefined) this.repairStarted = now;
    const phaseRemaining = isAgent ? this.config.maxDurationMs-(now-this.started)-this.config.executionReserveMs : semantic
      ? this.config.semanticPlanningTimeoutMs - (now - this.started)
      : this.config.repairBudgetMs - (now - this.repairStarted!);
    const primaryRecoveryReserve=semantic&&this.config.recovery.enabled?Math.min(this.config.repairBudgetMs,this.config.recovery.maxDurationMs,Math.max(0,this.config.maxDurationMs-this.config.minimumRetryBudgetMs-this.config.executionReserveMs)):0;
    const totalRemaining = reservedRecovery ? this.config.recovery.maxDurationMs-(now-this.repairStarted!) : this.config.maxDurationMs - (now - this.started) - primaryRecoveryReserve - (primaryRecoveryReserve>0?this.config.executionReserveMs:0);
    const available = isAgent ? request.timeoutMs : Math.min(phaseRemaining, totalRemaining);
    const completed = this.calls.filter((c) => c.status === "SUCCESS" && (reservedRecovery ? c.purpose===request.purpose : c.purpose?.startsWith("semantic") && c.purpose!=="semantic-recovery"));
    const estimated = Math.max(
      this.config.minimumRetryBudgetMs,
      ...completed.map((c) => c.latencyMs * 1.05),
    );
    if (
      available <= 0 ||
      (!isAgent && this.calls.length > 0 &&
        available < estimated + this.config.executionReserveMs)
    ) {
      const code = isAgent ? "AGENT_TIME_BUDGET" : semantic ? "SEMANTIC_TIME_BUDGET" : "REPAIR_TIME_BUDGET";
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
      inputBudget: budget,
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
    this.phase = "provider-call";
    this.providerInitializationStatus = "STARTED";
    const start = performance.now();
    await this.diagnostic("provider-started", {
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
        reservedRecovery?this.recoverySignal:this.signal,
        ...(request.signal?[request.signal]:[]),
        AbortSignal.timeout(timeoutMs),
      ]);
      const pending = adapter.generate({
        ...request,
        timeoutMs,
        signal: limit,
      });
      const result = await abortable(pending, limit).catch(error=>{const code=providerAbortCode(error);if(code)throw new NormalizedProviderError(code,code==='PROVIDER_TIMEOUT'?'Provider deadline elapsed':'User or run cancelled');throw error;});
      if (result.toolCalls.length)
        throw new BudgetError("UNSUPPORTED_TOOL_CALL");
      call.usage = result.usage;
      call.cost = result.estimatedCost;
      call.diagnostics = result.diagnostics;
      call.status = "SUCCESS";
      if (result.usage && result.usage.outputTokens > request.maxOutputTokens)
        throw new BudgetError("OUTPUT_TOKEN_BUDGET");
      if (
        !isAgent && this.config.maxEstimatedCost !== null &&
        result.estimatedCost !== null &&
        known + result.estimatedCost > this.config.maxEstimatedCost
      )
        throw new BudgetError("COST_BUDGET");
      if(!reservedRecovery)this.checkpoint();
      this.providerInitializationStatus = "READY";
      this.phase = request.purpose ?? "semantic-planning";
      return { ...result, callIndex: this.calls.indexOf(call) + 1 };
    } catch (e) {
      const event = await this.supervisor.observe(e,request.purpose??"provider-call",{evidence:[{provider:adapter.id,requestBytes:call.requestBytes,stack:e instanceof Error?e.stack:undefined}]});
      call.status = String(e);
      call.latencyMs = performance.now()-start;
      this.providerInitializationStatus = "CALL_FAILED";
      const code = (e as {code?:string})?.code;
      if (!transportRetried && !this.signal.aborted && ["TRANSPORT","PROVIDER_TRANSPORT_ERROR","PROVIDER_EVENT_PARSE_ERROR"].includes(code ?? "") && (isAgent || this.calls.length < this.config.maxLLMCalls)) {
        const recovery = await this.supervisor.attempt(event, {strategy:"deterministic",procedure:"bounded-provider-transport-retry/1",reason:"One transient transport retry against the identical immutable request; normal call/time/context budgets still apply",run:()=>this.invoke(adapter,request,true),verify:async result=>({status:"PASSED",responseReceived:true,callIndex:result.callIndex})});
        if (recovery.ok) return recovery.value!;
        throw recovery.error;
      }
      throw e;
    } finally {
      if(!call.latencyMs)call.latencyMs = performance.now() - start;
      this.events.push({
        stage: "provider-completed",
        at: new Date().toISOString(),
        durationMs: performance.now() - this.started,
        data: {
          callIndex: this.calls.indexOf(call) + 1,
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
      privacy: this.config.privacy,
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
        executionRole: this.executionRole,
        productionId: this.productionId,
        directCheckpointId:this.directCheckpointId,
        ownerPid: process.pid,
        ownerHost: hostname(),
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
        failure: this.failure ?? null,
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
  private async recoveryLesson(status:string) {
    if(status!=="SUCCESS")return undefined;
    const file=path.join(this.project.root,"motion/ai",this.runId,"recovery.json");
    try { const r=JSON.parse(await readFile(file,"utf8"));
      if(r.status==="Project Recovered"&&typeof r.procedure==="string")return {procedure:r.procedure,failureCode:String(r.originalFailure?.code??"UNKNOWN"),verifiedCommit:true};
    } catch(e) { if((e as NodeJS.ErrnoException).code!=="ENOENT")console.warn("Recovery lesson unavailable"); }
    return undefined;
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
    const verified=status==="SUCCESS" && (result?.reconciliation as {status?:string}|undefined)?.status==="SUCCESS";
    if(!["SUCCESS","HANDOFF","STAGED_VERIFIED","TASK_CONTRACT_CONFLICT","PAUSED_RESUMABLE","CANCELLED"].includes(status)&&!this.supervisor.report.events.length)await this.supervisor.settle(Error("UNVERIFIED_RESULT: "+status),"final-reconciliation",{}, {evidence:[result?.reconciliation]});
    await this.supervisor.complete(verified,result?.reconciliation);
    if(!this.scratch&&this.config.privacy==="full")await rememberSupervisor(this.project.root,this.supervisor.report,digest(this.references)).catch(error=>console.warn("Recovery experience persistence failed:",String(error)));
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
    this.repairAttempts = Math.max(this.repairAttempts,
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
      ) ?? 0);
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
          recoveryLesson: await this.recoveryLesson(status),
        });
      if (!this.scratch && this.config.privacy !== "off") {
        // Local deterministic collection only: no evaluation/model call on the prompt path.
        await collectImprovements(this.project.root).catch(error => console.warn("Improvement collection:",String(error)));
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
        try {
          return JSON.parse(await readFile(file, "utf8")) as Record<
            string,
            unknown
          > &
            MetricRun;
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          return { runId: f, status: "CORRUPT_DIAGNOSTIC" } as Record<
            string,
            unknown
          > &
            MetricRun;
        }
      }),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
export async function recoverInterruptedRuns(root: string) {
  for (const r of await readRuns(root)) {
    if (r.status !== "RUNNING" || r.ownerPid === process.pid) continue;
    if (r.ownerHost && r.ownerHost !== hostname()) continue;
    if (typeof r.ownerPid !== "number" || r.ownerPid <= 0) continue;
    try {
      process.kill(r.ownerPid, 0);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
    }
    let receipt: unknown = null;
    try {
      const motionFile = path.join(root, "motion/motion.json");
      await noSymlinkPath(root, motionFile);
      const doc = JSON.parse(await readFile(motionFile, "utf8"));
      if (doc.lastCommit?.transactionId === r.runId) receipt = doc.lastCommit;
    } catch {
      /* Corrupt/missing state is never inferred as committed. */
    }
    await atomicJson(
      path.join(root, "motion/harness/runs", String(r.runId), "run.json"),
      {
        ...r,
        status: "INTERRUPTED",
        recovery: {
          commit: receipt ? "CONFIRMED" : "NOT_CONFIRMED",
          receipt,
          automaticReplay: false,
          reason:
            "Owner process terminated; inspect canonical state and receipt before retry",
        },
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
