import {executeAgentMotion} from './agent-runtime.js';
import {buildMotionPatch,validatePatchRevision} from './motion-patch.js';
import { inspectSemanticCoverage, SemanticCoverageError } from "./intent/coverage.js";
import { codeVersions } from "../harness/versions.js";
import { semanticEditRoute, incrementalContext, incrementalPlan,incrementalDisclosure } from "./incremental-edit.js";
import {ruleQA} from "./rule-qa.js";
import {preparePlanSkills} from "../motion-library/skills/runtime.js";
import {compositionQA} from "../native/composition-qa.js";
import {projectTime} from "./project-time.js";
import {runtimeCode} from "../runtime-code.js";
import {deferRecovery,drainRecoveries} from "../harness/recovery/jobs.js";
import type {IntentPlan} from "./intent/schema.js";
import {reviewCodeRepair} from "../harness/recovery/code-repair.js";
import { recoveryProviderRuntime } from "../harness/recovery/provider-runtime.js";
import { proposeCodeRepair } from "../harness/recovery/code-service.js";
import { recoveryFailure } from "../harness/recovery/failure.js";
import { recoverPreflight, recoveryDecisionSchemaFor, type RecoveryReport } from "../harness/recovery/runtime.js";
import { rememberRecovery } from "../harness/recovery/memory.js";
import { compileTasks } from "./intent/compiler.js";
import { commitChanges } from "./tool-runtime.js";
import { duringStage,failureDiagnostic } from "../harness/failure.js";
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
import { semanticPlan,validateIntentPlan, SemanticCodexProvider } from "./intent/planner.js";
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
import { taskRepairInstructions } from "./intent/repair-context.js";
import { planSchema } from "./schema.js";
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
    editId:z.string().uuid().optional(),
    mode: z.enum(["create", "edit"]),
    request: z.string().min(1).max(20000),
    mentions: z.array(mentionSchema).max(100).default([]),
    selectedObjectId: z.string().max(180).optional(),
    selectedObjectIds: z.array(z.string().max(180)).max(200).optional(),
    selectedSceneId: z.string().max(180).optional(),
    activeSceneId: z.string().max(180).optional(),
    currentFrame:z.number().int().optional(),
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
    time: projectTime(document.state,document.revision),
    renderer: renderingMode(),
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
      run.phase = "provider-settings-initialization";
      await run.captureFailure(error);
      try {
        await run.diagnostic("provider-settings-validation", error.diagnostic);
      } finally {
        await run.finish("FAILED");
      }
    }
    throw error;
  }
}
export async function superviseRunFailure(harness:HarnessRun,error:unknown,project:LoadedProject,settings:Parameters<typeof proposeCodeRepair>[3]|undefined,onStage:(stage:string)=>void,revision="unknown"){
  harness.supervisor.setRevision(revision);
  const diagnostic=failureDiagnostic(error,harness.phase,harness.providerInitializationStatus,true);
  const legacy=(error as {recoveryReport?:RecoveryReport}).recoveryReport;
  const secondary=recoveryFailure(error,diagnostic.failureStage,revision);
  const parentEvent=[...harness.supervisor.report.events].reverse().find(e=>e.stage!=="context-admission");
  const rootEvent=parentEvent?harness.supervisor.report.events.find(e=>e.id===parentEvent.rootEventId):undefined;
  const failure=structuredClone(legacy?.originalFailure??rootEvent?.failure??secondary);
  failure.causalChain=[{stage:failure.stage,code:failure.code,invariant:failure.invariant},...harness.supervisor.report.events.filter(e=>e.rootEventId===rootEvent?.id).map(e=>({stage:e.stage,code:e.errorCode,invariant:e.rootCause})),{stage:secondary.stage,code:secondary.code,invariant:secondary.invariant}].slice(-12);
  failure.evidence.push({source:"causal-chain",detail:JSON.stringify({original:failure,secondary,events:harness.supervisor.report.events.map(e=>({id:e.id,parentEventId:e.parentEventId,rootEventId:e.rootEventId,stage:e.stage,code:e.errorCode,cause:e.rootCause}))})});
  failure.evidence.push({source:"stack",detail:diagnostic.safeStackTrace.join("\n")});
  if(legacy)failure.evidence.push({source:"existing-recovery",detail:JSON.stringify({original:legacy.originalFailure,terminal:legacy.terminalFailure,attempts:legacy.attempts.map(a=>({action:a.action,outcome:a.outcome}))}).slice(0,8000)});
  const readEvidence=async(name:string)=>{try{const file=path.join(harness.directory,name);await noSymlinkPath(harness.directory,file);const data=await readFile(file,"utf8");if(Buffer.byteLength(data)>1048576)return undefined;return JSON.parse(data);}catch{return undefined;}};
  const contract=await readEvidence("intent-contract.json"),preflight=await readEvidence("compilation-preflight.json");
  const affected=(contract?.requirements??[]) as {requirementId:string;target:{sourceNodeId?:string}}[];
  const attemptedOperations=(preflight?.reports??[]).flatMap((r:{operations?:unknown[]})=>r.operations??[]).slice(0,100);
  const report=await harness.supervisor.settle(error,diagnostic.failureStage,{
    codeEnabled:harness.config.recovery.codeRepair.enabled,
    ...(settings?{code:{strategy:"code" as const,procedure:"isolated-source-investigation/1",reason:"Stage repair did not produce a verified result; investigate relevant source contracts in isolation without changing active code",
      run:async(signal:AbortSignal)=>{onStage("investigating-recovery");return proposeCodeRepair(process.cwd(),{...failure,evidence:[...failure.evidence,...harness.supervisor.report.events.slice(-3).map(e=>({source:e.stage,detail:e.rootCause}))]},harness.config.recovery,settings,AbortSignal.any([harness.recoverySignal,signal]),async call=>{harness.calls.push({...call,purpose:"code-repair"});await harness.diagnostic("code-provider-completed",call);});},
      verify:async(value:unknown)=>{
        const proposal=value as Awaited<ReturnType<typeof proposeCodeRepair>>;
        if(proposal.status==="AWAITING_APPROVAL"&&"workspace" in proposal){const review=await reviewCodeRepair(proposal.workspace as string);if(review.status!=="AWAITING_APPROVAL"||!review.tests?.every((t:{status:string})=>t.status==="PASSED")||!review.baseline?.some((t:{status:string})=>t.status==="FAILED"))throw Error("CODE_REPAIR_VERIFICATION_MISSING");return {status:"PATCH_VERIFIED",identity:review.patchIdentity,productionChanged:false};}
        return {status:"NO_VERIFIED_PATCH",reason:"reason" in proposal?proposal.reason:proposal.status};
      }}}:{}),
  },{parentEventId:parentEvent?.id,requirements:affected.map(r=>r.requirementId),objects:affected.flatMap(r=>r.target.sourceNodeId?[r.target.sourceNodeId]:[]),operations:attemptedOperations,evidence:[{stack:diagnostic.safeStackTrace,contractAvailable:!!contract,preflightAvailable:!!preflight},(error as {contextAdmission?:unknown}).contextAdmission,...failure.evidence]});
  if(harness.config.privacy==="full"){
    await atomicJson(path.join(harness.directory,"code-repair.json"),report.codeRepair??{status:report.status==="RECOVERY_NOT_NEEDED"?"NOT_NEEDED":"NOT_APPLICABLE",reason:report.finalReason,decisions:report.decisions});
    if(legacy)await atomicJson(path.join(harness.directory,"recovery.json"),{...legacy,supervisor:report.status,reason:report.finalReason});
  }
  return report;
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
    resumeContract?:IntentPlan;runId?:string;deferredRecovery?:boolean;executionRuntime?:"agent"|"legacy";
  } = {},
) {
  let settingsSource = "api";
  const id = options.runId??randomUUID();
  const { request, doc, savedSettings } = await (async () => {
    let stage = "request-preparation";
    try {
      const request = await prepareMotionRequest(project, input, (source) => {
        settingsSource = source;
      });
      stage = "project-state-read";
      const doc = await readMotion(project);
      if (doc.revision !== request.expectedRevision)
        throw new Error("Анимация изменилась до запроса. Обновите страницу.");
      stage = "provider-settings-persistence";
      const savedSettings = await saveProviderSettings(
        project,
        request.settings,
        "execution",
      );
      return { request, doc, savedSettings };
    } catch (error) {
      if (execute) {
        const text =
          input &&
          typeof input === "object" &&
          "request" in input &&
          typeof input.request === "string"
            ? input.request
            : "";
        const run = await HarnessRun.start(
          project,
          id,
          text,
          null,
          "",
          options.signal,
          options.config,
        );
        run.phase = stage;
        await superviseRunFailure(run,error,project,undefined,onStage);
        await run.captureFailure(error);
        await run.finish("FAILED");
      }
      throw error;
    }
  })();
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
  if (harness) {harness.providerInitializationStatus = "SETTINGS_VALIDATED";harness.supervisor.setRevision(doc.revision);}
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
    const localResolveStart=performance.now();
    const editRoute=harness?semanticEditRoute(project,request.request,doc,request):null;
    const incrementalProfile=editRoute?.profile??null;
    const localEdit=editRoute?.edit??null;
    const localMetrics={route:localEdit?'LOCAL_FAST_PATH':'AI_FALLBACK',executionMode:editRoute?.mode??'FULL_SEMANTIC_PLANNING',objectResolutionMs:performance.now()-localResolveStart,patchConstructionMs:0,applyMs:0,qaMs:0,ruleQAReused:false};
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
    if (harness) harness.phase = "context-construction";
    const selectedContext = harness
      ? incrementalProfile
        ? await (async () => { const value = incrementalContext(project, doc, request.request, incrementalProfile); return {value, bytes:Buffer.byteLength(JSON.stringify(value)), cacheHit:false, references:await codeVersions(), contextDigest:digest(value)}; })()
        : contextualEditHint
        ? await selectorContext(project, doc, request, recent, harness.config)
        : await duringStage("context-construction", () =>
            agentContext(project, doc.state, request, recent, harness.config),
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
    enrichedContext.project = {...(enrichedContext.project as Record<string,unknown>), time:projectTime(doc.state,doc.revision)};
    enrichedContext.selectedObjectIds =
      request.selectedObjectIds ??
      (request.selectedObjectId ? [request.selectedObjectId] : []);
    enrichedContext.contextualEditHint = contextualEditHint;
    if (incrementalProfile) {
      enrichedContext.incrementalEditHint = true;
      enrichedContext.deterministicEdit = localEdit;
    }
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
        internalBytes:
          "internalBytes" in selectedContext
            ? selectedContext.internalBytes
            : selectedContext.bytes,
        references: selectedContext.references,
      });
    }
    if (harness) {
      harness.phase = "provider-initialization";
      harness.providerInitializationStatus = "SETTINGS_VALIDATED";
    }
    await atomicJson(path.join(directory, "context.json"), enrichedContext);
    await safeDirectory(project.root, "motion/ai");
    if (harness)
      await harness.record("provider-settings", {
        source: settingsSource,
        providerInitializationStatus: "SETTINGS_VALIDATED",
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
        let semanticRecoveryActive=false;
        let semanticRecoverySignal:AbortSignal|undefined;
        let semanticRecoveryStart:number|undefined;
        const recoverSemantic=async(error:unknown,stage:string,replay:()=>Promise<ReturnType<typeof validateIntentPlan>>)=>{
          if(!harness||!harness.config.recovery.enabled||harness.config.recovery.semanticRecoveryCalls===0)throw error;
          semanticRecoveryStart??=harness.calls.length;
          const event=await harness.supervisor.observe(error,stage,{evidence:[{code:(error as {code?:string}).code}]});
          const outcome=await harness.supervisor.attempt(event,{strategy:"project",procedure:stage==="semantic-repair"?"compact-semantic-field-patch/1":"grouped-semantic-output/1",reason:stage==="semantic-repair"?"Repair only affected fields while retaining the valid plan":"No complete initial plan is available; retry compact grouped output in the reserved recovery lane",run:async(signal)=>{
            semanticRecoverySignal=signal;
            if(!harness.config.recovery.enabled||harness.config.recovery.semanticRecoveryCalls===0)throw Error("SEMANTIC_RECOVERY_DISABLED");
            semanticRecoveryActive=true;onStage("recovering-project");try{return await replay();}finally{semanticRecoveryActive=false;}
          },verify:async candidate=>{
            const checked=validateIntentPlan(project,request.request,candidate,doc.state.settings.fps,{state:doc.state,mentions:request.mentions,activeSceneId:request.activeSceneId,selectedObjectId:request.selectedObjectId,recentActions:recentSuccessfulActions(doc,true),projectRevision:doc.revision});
            return {status:"PASSED",requirementCount:checked.requirements.length,completeSemanticValidation:true,projectChanged:false};
          }});
          if(outcome.ok)return outcome.value;
          throw error; // child failure is already recorded; preserve the initiating provider/semantic cause.
        };
        const semanticProvider = new SemanticCodexProvider(
          async (phase) =>
            new CodexProvider(
              semanticRecoveryActive&&harness ? {...request.settings,model:harness.config.recovery.model}:request.settings,
              await providerDirectory(`semantic-${phase}`),
              semanticRecoveryActive&&harness ? {...recoveryProviderRuntime(harness,semanticRecoveryStart??harness.calls.length),signal:semanticRecoverySignal??harness.recoverySignal,
                invoke:async(adapter,input)=>{
                  if(harness.calls.filter(c=>c.purpose==="semantic-recovery").length>=harness.config.recovery.semanticRecoveryCalls)throw Error("SEMANTIC_RECOVERY_CALL_BUDGET");
                  return recoveryProviderRuntime(harness,semanticRecoveryStart??harness.calls.length).invoke(adapter,{...input,purpose:"semantic-recovery"});
                }}:harness?.providerRuntime(),
            ),
          {readContext:async queries=>{if(!incrementalProfile)throw Error('INCREMENTAL_CONTEXT_REQUIRED');const data=incrementalDisclosure(project,doc,incrementalProfile,queries);await harness?.diagnostic('context-disclosure',{queries,bytes:Buffer.byteLength(JSON.stringify(data)),projectRevision:doc.revision});return data;},recover:recoverSemantic,diagnostic:async value=>{if(value){await atomicJson(path.join(directory,"intent-repair-scope.json"),value);await harness?.diagnostic("semantic-repair-scope",value);}}},
        );
        const localContract = localEdit ? (()=>{
          const start=performance.now();
          const plan=validateIntentPlan(project,request.request,incrementalPlan(request.request,[localEdit],enrichedContext),doc.state.settings.fps,{state:doc.state,projectRevision:doc.revision});
          const coverage=inspectSemanticCoverage(project,request.request,plan,doc.state.settings.fps);
          if(coverage.status!=='PASSED')throw new SemanticCoverageError(coverage);
          localMetrics.patchConstructionMs+=performance.now()-start;
          return plan;
        })() : undefined;
        if(localContract){if(harness)harness.phase='local-fast-path';onStage('local-edit');await harness?.diagnostic('incremental-edit-route',{...localMetrics,llmCalls:0});await atomicJson(path.join(directory,'intent-contract.json'),localContract);}
        const contract = localContract ?? (options.resumeContract?validateIntentPlan(project,request.request,options.resumeContract,doc.state.settings.fps,{state:doc.state,projectRevision:doc.revision,mentions:request.mentions}):await semanticPlan(
          project,
          request.request,
          enrichedContext,
          semanticProvider,
          async (stage, value) => {
            if(harness&&stage.startsWith("coverage-suspicious"))await harness.supervisor.observe(Object.assign(Error("SEMANTIC_COVERAGE: "+JSON.stringify((value as {issues?:unknown}).issues??value)),{code:"SEMANTIC_COVERAGE"}),"semantic-coverage",{evidence:[value]});
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
            recover:recoverSemantic,
            mentions: request.mentions,
            recentActions: recentSuccessfulActions(doc, true),
            projectRevision: doc.revision,
            selectedObjectIds: request.selectedObjectIds,
            maxAttempts: harness?.config.maxLLMCalls ?? 3,
            motionState: doc.state,
            activeSceneId: request.activeSceneId,
            selectedObjectId: request.selectedObjectId,
          },
        ));
        if (harness) {
          await harness.record("intent-plan", {
            requirements: contract.requirements,
          });
          runQA = new RunQA(harness);
        }
        if(harness)harness.phase="compilation-preflight";
        const recoveryCallStart = harness?.calls.length ?? 0;
        let recoveryReport: RecoveryReport | undefined;
        let preparedPlans: ReturnType<typeof preflightIntentPlan>["preparedPlans"] | undefined;
        if (
          contract.requirements.some(
            (r) => r.semanticActionId || r.effectOperation || r.motionAction,
          )
        ) {
          try {
            const compileStart=performance.now();
            const preflight = preflightIntentPlan(project, doc.state, contract);
            localMetrics.patchConstructionMs+=performance.now()-compileStart;
            preparedPlans = preflight.preparedPlans;
            const { preparedPlans: runtimeOnlyPlans, ...preflightReport } = preflight;
            const report = { ...preflightReport, preparedPlanCount: runtimeOnlyPlans.size };
            await atomicJson(
              path.join(directory, "compilation-preflight.json"),
              report,
            );
            await harness?.diagnostic("compilation-preflight", report);
          } catch (error) {
            const preflightEvent=harness?await harness.supervisor.observe(error,"preflight",{requirements:contract.requirements.map(r=>r.requirementId),objects:contract.requirements.flatMap(r=>r.target.sourceNodeId?[r.target.sourceNodeId]:[]),evidence:[(error as {report?:unknown}).report]}):undefined;
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
            if (!harness?.config.recovery.enabled || !harness.config.recovery.maxAttempts) throw error;
            onStage("recovering-project");
            const recoveryStart = recoveryCallStart;
            const policy = harness.config.recovery;
            const performRecovery=()=>recoverPreflight(project, doc.state, contract, error, {
              policy, revision: doc.revision, request: request.request,
              checkpoint: () => harness.recoveryCheckpoint(),
              record: async report => {
                recoveryReport = report;
                const calls = harness.calls.slice(recoveryStart);
                report.metrics = { llmCalls: calls.length, inputTokens: calls.every(c=>c.usage!==null) ? calls.reduce((n,c)=>n+c.usage!.inputTokens,0) : null, outputTokens: calls.every(c=>c.usage!==null) ? calls.reduce((n,c)=>n+c.usage!.outputTokens,0) : null, estimatedCost: calls.length && calls.every(c=>c.cost!==null) ? calls.reduce((n,c)=>n+c.cost!,0) : null };
                await atomicJson(path.join(directory, "recovery.json"), { ...report, calls: harness.calls.slice(recoveryStart) });
                await harness.diagnostic("project-recovery", report);
              },
              decide: async (context, legacy, remainingMs) => {
                harness.repairAttempts++;
                const calls = harness.calls.slice(recoveryStart);
                const used = calls.reduce((n,c) => n + (c.usage ? c.usage.inputTokens + c.usage.outputTokens : 0), 0);
                const cost = calls.reduce((n,c) => n + (c.cost ?? 0), 0);
                if (used >= policy.maxTokens || policy.maxEstimatedCost !== null && cost >= policy.maxEstimatedCost) throw new Error("RECOVERY_PROVIDER_BUDGET");
                const provider = new CodexProvider({ ...request.settings, model: policy.model }, await providerDirectory("project-recovery-" + harness.repairAttempts), recoveryProviderRuntime(harness, recoveryStart, remainingMs));
                if (legacy) { const decision = await provider.structured(context, request.request,
                  "Resolve only this lifecycle conflict. Decide whether the original user authorized removing this base animation and dependent effects. Use actual inspected identities. Return stop for ambiguous or unauthorized deletion. Source objects and unrelated tracks are immutable.",
                  z.object({ action:z.enum(["removeAnimation","stop"]), dependentPolicy:z.enum(["reject","removeDependents"]), reason:z.string().max(1000) }).strict(), "preflight-resolution");
                  await atomicJson(path.join(directory,"preflight-resolution.json"),decision); return decision; }
                return provider.structured(context, request.request,
                  "You are a structured decision service. Native Codex tools are intentionally unavailable. The response commands array is a SERIALIZED tool plan; the trusted Harness executes it after your response. This is not a request to call a Codex tool yourself. Repair ONLY the failed original requirement using the typed commands in the schema. Inspect authoritative entities if necessary; supplied canonical identities and dependency records are already inspected state. Preserve IDs, original requested parameters, geometry, timeline constraints and unrelated motion. Never fabricate IDs. Return inspect, apply a minimal serialized command batch, or stop for real ambiguity/missing capability. Do not report missing capability merely because native Codex tools are disabled. Candidate scope, original intent, technical validation and native QA cannot be bypassed. No shell, filesystem or source-code capability exists.",
                  recoveryDecisionSchemaFor((context as {failure?:{code?:string}}).failure?.code), "project-recovery");
              },
            });
            const outcome=await harness.supervisor.attempt(preflightEvent!,{strategy:"project",procedure:"existing-preflight-recovery/1",reason:"Use existing typed-tool and deterministic recovery against original intent",run:performRecovery,verify:async recovered=>{const overrides=new Map([...recovered.prepared.preparedPlans].map(([id,value])=>[id,value.compiled]));preflightIntentPlan(project,doc.state,recovered.plan,overrides);return {status:"PASSED",replayedPreflight:true,validatedRecoveredOperations:true};}});
            if(!outcome.ok)throw outcome.error;
            const recovered=outcome.value;
            Object.assign(contract, recovered.plan);
            preparedPlans = recovered.prepared.preparedPlans;
            const { preparedPlans: runtimeOnly, ...recoveredReport } = recovered.prepared;
            await atomicJson(path.join(directory, "intent-contract.json"), contract);
            await atomicJson(path.join(directory, "compilation-preflight.json"), { ...recoveredReport, preparedPlanCount: runtimeOnly.size, recovery: recovered.report });

          }
        }
        let committed = doc;
        if(harness)harness.phase="operation-execution";
        const generated = await runIntentTasks(project, doc.state, contract, {
          preparedPlans,
          repair: async (ctx, text, task, attempt) => {
            const event=harness?await harness.supervisor.observe(Error("TASK_REPAIR_REQUIRED"),"operation-repair",{requirements:task.requirementIds,objects:[task.targetReference.targetId]}):undefined;
            const perform=async()=>{
            onStage("repairing");
            if (harness) harness.repairAttempts++;
            const provider = new CodexProvider(
              harness ? { ...request.settings, model: harness.config.recovery.model } : request.settings,
              await providerDirectory(`${task.taskId}/attempt-${attempt}`),
              harness ? recoveryProviderRuntime(harness, recoveryCallStart) : undefined,
            );
            return parsePlan(
              await provider.structured(
                ctx,
                text,
                taskRepairInstructions,
                planSchema,
                "task-repair",
              ),
            );
            };
            if(!harness)return perform();
            const recovered=await harness.supervisor.attempt(event!,{strategy:"project",procedure:"existing-motion-operation-repair/1",reason:"Existing scoped Motion Operations repair; candidate still requires execution and QA",run:perform,verify:async plan=>({status:"CANDIDATE",operationCount:plan.operations.length,executionQA:"PENDING"})});
            if(!recovered.ok)throw recovered.error;return recovered.value;
          },
          verify: async (task, next, before, attempt) => {
            onStage("checking");
            const ruleRequirement=contract.requirements.find(r=>task.requirementIds.includes(r.requirementId)&&r.semanticEdit);
            if(ruleRequirement){const started=performance.now();const report=await ruleQA(project,next,before,options.signal,()=>harness?.beforeRender(),localEdit?{scale:.25}:{});localMetrics.qaMs+=performance.now()-started;if(harness)harness.qaDurationMs+=performance.now()-started;await atomicJson(path.join(directory,task.taskId+"-rules-qa.json"),report);await atomicJson(path.join(directory,"rules.json"),{taskId:task.taskId,rules:harness&&harness.config.privacy!=="full"?"REDACTED":next.motionRules,materializations:next.ruleMaterializations,qa:report});return report;}
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
            if(qa.status==="FAILED"&&harness)await harness.supervisor.observe(Object.assign(Error("MOTION_QA_FAILED"),{code:"MOTION_QA_FAILED"}),"motion-qa",{requirements:task.requirementIds,evidence:[qa]});
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
          maxAttempts: 1 + (harness ? (harness.config.recovery.enabled ? Math.min(harness.config.maxRepairAttempts, Math.max(0, harness.config.recovery.maxAttempts - (recoveryReport?.attempts.length ?? 0))) : 0) : 2),
          trace: async (tasks, entry) => {
            if (harness && entry) {
              if ((entry as { status?: string }).status === "repair") {
                const error = (
                  entry as { feedback?: { failureReason?: string } }
                ).feedback?.failureReason;
                if (error) {
                  await harness.supervisor.observe(Error(error),"task-repair",{evidence:[entry]});
                  harness.failures.push(error.split(":")[0]);
                  await harness.diagnostic("recovery-failure", recoveryFailure(new Error(error), "motion-qa", doc.revision));
                }
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
        if(harness)harness.phase="final-reconciliation";
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
        if (recoveryReport && generated.reconciliation.status !== "SUCCESS") {
          recoveryReport.status = "Failed Safely";
          await atomicJson(path.join(directory,"recovery.json"),recoveryReport);
          throw new Error("RECOVERY_FINAL_INTENT_FAILED: entire candidate rolled back");
        }
        if(generated.reconciliation.status!=="SUCCESS"&&harness){
          const failure=Object.assign(Error("UNVERIFIED_MOTION_RESULT"),{code:"UNVERIFIED_MOTION_RESULT",report:{failure:JSON.stringify(generated.requirements.filter(r=>r.status!=="PASSED").map(r=>({requirementId:r.requirementId,error:r.error,qaResult:r.qaResult})))}});
          await superviseRunFailure(harness,failure,project,request.settings,onStage,doc.revision);
        }
        if(generated.reconciliation.status==="SUCCESS"&&contract.skillBindings?.length){
          const skillStarted=performance.now();
          const prepared=await preparePlanSkills(project,generated.next,contract,{signal:options.signal,beforeRender:()=>harness?.beforeRender()}).catch(async error=>{
            const report=(error as Error&{report?:unknown}).report;
            await atomicJson(path.join(directory,"skills.json"),[{skill:"text.handoff.no-overlap",status:"FAILED",...(harness&&harness.config.privacy!=="full"?{reason:String(error)}:{report,reason:String(error)})}]);
            throw error;
          });
          if(harness)harness.qaDurationMs+=performance.now()-skillStarted;
          generated.next=prepared.state;generated.operationBatches.push(prepared.operations);generated.plan.operations.push(...prepared.operations);
          generated.plan.assumptions.push(...prepared.reports.filter(r=>r.strategy!=="unchanged").map(r=>`Text Handoff: входящий текст сдвинут по времени; политика ${r.application.overlapPolicy}, подробности в Inspector.`));
          generated.reconciliation.operationCount+=prepared.operations.length;generated.reconciliation.appliedOperationCount+=prepared.operations.length;generated.reconciliation.compiledOperationCount+=prepared.operations.length;
          await atomicJson(path.join(directory,"skills.json"),prepared.reports);await harness?.record("motion-skills",prepared.reports.map(r=>({skill:r.skill,application:r.application,strategy:r.strategy,status:r.after.status})));
        }
        if(generated.reconciliation.status==="SUCCESS"&&renderingMode()==="native"&&generated.next.objectTransitions?.some(t=>t.timelinePolicy==="referenceStates")){
          const changed=localEdit?generated.next.expressions?.filter(e=>JSON.stringify(e)!==JSON.stringify(doc.state.expressions?.find(p=>p.expressionId===e.expressionId))):undefined;
          const affectedFrames=changed?.flatMap(e=>[e.startFrame-1,e.startFrame,e.startFrame+Math.floor(e.durationFrames/2),e.startFrame+e.durationFrames-1]);
          const compositionStart=performance.now();
          const composition=await compositionQA(project,generated.next,`motion/qa/${id}/composition`,{signal:options.signal,beforeRender:()=>harness?.beforeRender(),...(affectedFrames?.length?{frames:affectedFrames}:{} )});
          localMetrics.qaMs+=performance.now()-compositionStart;if(harness)harness.qaDurationMs+=performance.now()-compositionStart;
          await harness?.record("composition-qa",{status:composition.status,frames:composition.frames,failedChecks:composition.checks.filter(c=>c.status==="FAILED")});
          if(composition.status==="FAILED")throw Object.assign(Error("COMPOSITION_QA_FAILED: candidate not committed"),{code:"COMPOSITION_QA_FAILED",report:composition});
        }
        if(incrementalProfile){
          const patch=buildMotionPatch(doc.state,generated.next,{transactionId:id,projectRevision:doc.revision,sourceInstruction:request.request,operations:generated.plan.operations,operationBatches:generated.operationBatches,targetIds:incrementalProfile.objects.map(o=>o.logicalObjectId),action:contract.requirements[0]?.semanticEdit?.operation,dependencyPolicy:contract.requirements[0]?.semanticEdit?.dependencyPolicy});
          validatePatchRevision(patch,doc.revision,doc.state);
          await atomicJson(path.join(directory,'motion-patch.json'),harness&&harness.config.privacy!=='full'?{schemaVersion:patch.schemaVersion,transactionId:id,projectRevision:patch.projectRevision,actions:patch.actions,beforeDigest:patch.beforeDigest,afterDigest:patch.afterDigest,status:'PREPARED_CONTENT_REDACTED'}:patch);
        }
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
          const applyStart=performance.now();
          const publication = await commitChanges(project.root, {
            signal:harness?.signal??options.signal,checkpoint:()=>harness?.checkpoint(),
            expectedRevision: doc.revision,
            expectedSourceFingerprint: project.inspection.fingerprint,
            operationBatches: generated.operationBatches,
            expectedCandidate: generated.next,
            transactionId: id,
            requestFingerprint:editRequestFingerprint(request),
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
          localMetrics.applyMs=performance.now()-applyStart;
          localMetrics.ruleQAReused="ruleQAReused" in publication&&publication.ruleQAReused===true;if(localMetrics.ruleQAReused&&harness)harness.cacheHits++;
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
        let incrementalPerformance: {executionMode:string;route:string;elapsedMs:number;providerCalls:number;expressions:{expressionId:string;oldValues:unknown;newValues:unknown}[]}|undefined;
        if(incrementalProfile){
          const entities=(state:typeof doc.state)=>[...(state.expressions??[]).map(e=>({id:e.expressionId,kind:'expression',value:e})),...state.animations.map(a=>({id:a.animationId,kind:'animation',value:a})),...(state.objectTransitions??[]).map(t=>({id:t.transitionId,kind:'transition',value:t})),...(state.motionRules??[]).map(r=>({id:r.ruleId,kind:'rule',value:r}))];
          const before=entities(doc.state),after=entities(committed.state);
          const changes=[...new Set([...before,...after].map(e=>e.kind+':'+e.id))].flatMap(key=>{const a=before.find(e=>e.kind+':'+e.id===key),b=after.find(e=>e.kind+':'+e.id===key);return JSON.stringify(a?.value)===JSON.stringify(b?.value)?[]:[{id:key,expectedPrevious:a?.value??null,newValue:b?.value??null}];});
          incrementalPerformance={executionMode:localMetrics.executionMode,route:localMetrics.route,elapsedMs:performance.now()-localResolveStart,providerCalls:harness?.calls.length??0,expressions:changes.filter(c=>c.id.startsWith('expression:')).map(c=>({expressionId:c.id.slice('expression:'.length),oldValues:c.expectedPrevious&&'parameters' in c.expectedPrevious?c.expectedPrevious.parameters:null,newValues:c.newValue&&'parameters' in c.newValue?c.newValue.parameters:null}))};
          const patch={editId:id,projectRevision:doc.revision,newRevision:committed.revision,logicalObjectIds:incrementalProfile.objects.map(o=>o.logicalObjectId),...localMetrics,llmCalls:harness?.calls.length??0,affectedObjectCount:incrementalProfile.objects.length,affectedOperationCount:generated.plan.operations.length,targetOperationIds:changes.map(c=>c.id),affectedFrameRanges:changes.flatMap(c=>{const values=[c.expectedPrevious,c.newValue].filter(v=>v&&typeof v==='object'&&'startFrame' in v) as {startFrame:number;durationFrames:number}[];return values.map(v=>({startFrame:v.startFrame,endFrame:v.startFrame+v.durationFrames}));}),dependencies:committed.state.timingDependencies?.filter(d=>changes.some(c=>c.id.endsWith(':'+d.animationId)||c.id.endsWith(':'+d.anchorAnimationId))),changes,validation:generated.reconciliation,cacheInvalidation:{policy:'new canonical state digest; no global cache clear; decoded source resources retain existing ownership',frameCache:'state-scoped; not per-object reuse'}};
          await atomicJson(path.join(directory,'incremental-edit.json'),{...patch,performance:incrementalPerformance});await harness?.diagnostic('incremental-edit',{...patch,performance:incrementalPerformance});
        }
        const result = {
          ...basis,
          incrementalPerformance,
          plan: generated.plan,
          tasks: generated.tasks,
          requirements: generated.requirements,
          intentContract: contract,
          reconciliation: generated.reconciliation,
          status: generated.reconciliation.completed ? "applied" : "failed",
          document: committed,
          time: projectTime(committed.state,committed.revision),
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
          if (recoveryReport) {
            const recovered = generated.reconciliation.status === "SUCCESS";
            recoveryReport.status = recovered ? "Project Recovered" : "Failed Safely";
            await atomicJson(path.join(directory, "recovery.json"), recoveryReport);
            await harness?.diagnostic("project-recovery-final", recoveryReport);
            if (harness?.config.privacy === "full" && recoveryReport.procedure)
              await rememberRecovery(project.root, recoveryReport.originalFailure.signature, recoveryReport.procedure, recovered);
          }
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
      let deferredId:string|undefined;
      const deadline=/EXECUTION_TIMEOUT|REPAIR_TIME_BUDGET|RECOVERY_TIME_BUDGET/.test(String(error));
      if(deadline&&!options.deferredRecovery&&!options.signal?.aborted&&harness.config.privacy==="full"){
        try{
          const saved=JSON.parse(await readFile(path.join(directory,"intent-contract.json"),"utf8"));
          const job=await deferRecovery(project,id,doc.revision,request,saved,String(error));deferredId=job.id;
          await harness.diagnostic("recovery-deferred",{jobId:job.id,status:job.status,reason:job.reason});

        }catch(deferError){await harness.diagnostic("recovery-defer-unavailable",{reason:String(deferError)});}
      }
      await superviseRunFailure(harness,error,project,request.settings,onStage,doc.revision);
      await harness.captureFailure(error);
      if(deferredId){await harness.supervisor.defer(deferredId);if(error instanceof Error)Object.assign(error,{deferredJobId:deferredId});}
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
export function editRequestFingerprint(input:unknown){
 const r=input as Record<string,unknown>;
 const fields=['request','expectedRevision','selectedObjectId','selectedObjectIds','selectedSceneId','activeSceneId',...(r.currentFrame===undefined?[]:['currentFrame']),'mentions'];
 return digest(Object.fromEntries(fields.map(k=>[k,r[k]??null])));
}
export async function executeMotion(
  project: LoadedProject,
  input: unknown,
  onStage: (stage: string) => void = () => {},
  options: {
    signal?: AbortSignal;
    config?: Partial<HarnessConfig>;
    evalContext?: { evalId: string; datasetVersion: string };
    resumeContract?:IntentPlan;runId?:string;deferredRecovery?:boolean;executionRuntime?:"agent"|"legacy";
  } = {},
) {
  runtimeCode.assertCurrent();
  const delivery=(input as {editId?:string}).editId;
  if(delivery){
    z.uuid().parse(delivery);
    const doc=await readMotion(project),index=doc.history.findIndex(e=>e.transactionId===delivery);
    const recordedRequest=path.join(project.root,'motion/ai',delivery,'request.json');
    try{
      await noSymlinkPath(project.root,recordedRequest);
      const saved=JSON.parse(await readFile(recordedRequest,'utf8'));
      if(editRequestFingerprint(saved.request)!==editRequestFingerprint(await prepareMotionRequest(project,input)))throw Error('EDIT_ID_REUSED_WITH_DIFFERENT_REQUEST');
      if(index<0){try{await readFile(path.join(project.root,'motion/ai',delivery,'commit-verified.json'));if(doc.lastCommit?.transactionId===delivery&&doc.lastCommit.revision===doc.revision){const saved=JSON.parse(await readFile(path.join(project.root,'motion/ai',delivery,'proposal.json'),'utf8'));return {...saved,document:doc,time:projectTime(doc.state,doc.revision),replayed:true} as Awaited<ReturnType<typeof proposeMotion>>;}throw Error('TRANSACTION_NO_LONGER_EFFECTIVE');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(index>=0){
      const entry=doc.history[index];
      const prepared=await prepareMotionRequest(project,input);
      if(entry.requestFingerprint!==editRequestFingerprint(prepared))throw Error('EDIT_ID_REUSED_WITH_DIFFERENT_REQUEST');
      if(index>=doc.cursor)throw Error('TRANSACTION_ALREADY_UNDONE');
      const file=path.join(project.root,'motion/ai',delivery,'proposal.json');await noSymlinkPath(project.root,file);
      const saved=JSON.parse(await readFile(file,'utf8'));
      return {...saved,document:doc,time:projectTime(doc.state,doc.revision),replayed:true} as Awaited<ReturnType<typeof proposeMotion>>;
    }
  }
  if(/^(?:верни предыдущее значение|верни последнее изменение|отмени последнее изменение)[.!]?$/iu.test((input as {request?:string}).request?.trim()??'')){
    const request=await prepareMotionRequest(project,input),doc=await readMotion(project);
    const id=delivery??randomUUID();
    const run=await HarnessRun.start(project,id,request.request,request.settings.provider,request.settings.model,options.signal,options.config);
    try{
      await atomicJson(path.join(run.directory,'request.json'),{id,request,revision:doc.revision});
      const changed=await changeMotion(project.root,{expectedRevision:request.expectedRevision,transactionId:id,requestFingerprint:editRequestFingerprint(request),request:request.request,action:'undo',signal:options.signal});
      await run.diagnostic('incremental-edit',{route:'LOCAL_FAST_PATH',operation:'UNDO',llmCalls:0,projectRevision:doc.revision,newRevision:changed.document.revision});
      await run.finish('SUCCESS');
      const result={id,request,revision:doc.revision,sourceFingerprint:project.inspection.fingerprint,status:'applied',document:changed.document,time:projectTime(changed.document.state,changed.document.revision),taskExecution:true,playbackStart:0,plan:{status:'ready',summary:'Последнее изменение отменено',operations:[],warnings:[],assumptions:[]},reconciliation:{status:'SUCCESS',requested:1,completed:1},requirements:[],tasks:[],persistence:{status:'CONFIRMED'}} as unknown as Awaited<ReturnType<typeof proposeMotion>>;
      await atomicJson(path.join(run.directory,'proposal.json'),result);await atomicJson(path.join(run.directory,'commit-verified.json'),{revision:changed.document.revision,receipt:changed.document.lastCommit});return result;
    }catch(error){await run.captureFailure(error);await run.finish('FAILED');throw error;}
  }
  if((options.executionRuntime??process.env.AKELLA_MOTION_RUNTIME??"agent")==="agent"&&!options.resumeContract){
    const request=await prepareMotionRequest(project,input);if(request.settings.provider!=="manual-response"){await saveProviderSettings(project,request.settings,"execution");
    return await executeAgentMotion(project,request,onStage,{...options,requestFingerprint:editRequestFingerprint(request)}) as unknown as Awaited<ReturnType<typeof proposeMotion>>;}
  }
  onStage("generating");
  const result = await proposeMotion(project, input, onStage, true, {...options,...(delivery?{runId:delivery}:{})});
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

/** Bounded durable continuation; fresh run uses the saved validated contract, not another semantic plan. */
export async function resumeProjectRecoveries(project:LoadedProject){
 return drainRecoveries(project,async(job,signal)=>{
  const result=await executeMotion(project,job.request,()=>{}, {signal,resumeContract:job.contract,runId:job.replayRunId,deferredRecovery:true});
  if(!("reconciliation" in result)||result.reconciliation?.status!=="SUCCESS")throw Error("DEFERRED_RECOVERY_NOT_VERIFIED");
  return {runId:result.id,status:"SUCCESS"};
 });
}
