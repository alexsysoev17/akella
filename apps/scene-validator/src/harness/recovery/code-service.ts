import type {ProviderUsage} from "../providers/types.js";
import {codeSources,repairSourceAllowed} from "./source-routing.js";
import {reviewCodeRepair} from "./code-repair.js";
import {attestCodeRepair} from "./promotion.js";
import {codeSourceContext} from "./source-context.js";
import { z } from "zod";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { atomicJson, safeDirectory, noSymlinkPath } from "../../files.js";
import { redactSecrets } from "../security.js";
import { isolateCodeRepair, materializeCodeProposal, testCodeProposal, scopedCodeProposalSchema, normalizeCodeProposal, type CodeRepairWorkspace } from "./code-repair.js";
import { CodexProvider } from "../../motion/provider.js";
import type { ProviderSettings } from "../../motion/provider-settings.js";
import type { RecoveryPolicy } from "./config.js";
import type { RecoveryFailure } from "./failure.js";
/** Separate, one-call coding role. No Motion Tools, no shell, no production write grant.
 * No project assets or user prompt are sent; only code + a sanitized technical failure. */
export async function proposeCodeRepair(repository: string, failure: RecoveryFailure, policy: RecoveryPolicy, settings: ProviderSettings, signal?: AbortSignal, onCall?:(call:{provider:string;mode:"live"|"mock";model:string;latencyMs:number;usage:ProviderUsage|null;cost:number|null;status:string;requestBytes:{messages:number;schema:number;system:number;user:number}})=>Promise<void>) {
    if (!policy.codeRepair.enabled)
        return { status: "DISABLED", promotion: "DISABLED" };
    // A still-applicable verified proposal needs review, not another expensive investigation.
    const {createHash}=await import("node:crypto");
    const diagnosticFingerprint=createHash("sha256").update(JSON.stringify([failure.signature,failure.stage,failure.invariant])).digest("hex");
    try{
      const index=path.join(repository,"data/harness/code-repairs/index.json");await noSymlinkPath(repository,index);
      const rows=JSON.parse(await readFile(index,"utf8")) as {signature:string;workspaceId:string;status:string;diagnosticFingerprint?:string}[];
      for(const row of rows.filter(r=>r.diagnosticFingerprint===diagnosticFingerprint&&r.status==="AWAITING_APPROVAL").slice(-3).reverse()){
        // Workspace locations are recorded by the trusted parent, never reconstructed from model paths.
        const dir=path.join(repository,"data/harness/code-repairs/locations",row.workspaceId+".json");await noSymlinkPath(repository,dir);
        const saved=JSON.parse(await readFile(dir,"utf8"));const review=await reviewCodeRepair(saved.workspace);
        if(review.status!=="AWAITING_APPROVAL")continue;
        const {promisify}=await import("node:util"),{execFile}=await import("node:child_process");
        const head=(await promisify(execFile)("git",["rev-parse","HEAD"],{cwd:repository})).stdout.trim();if(head!==review.baseCommit)continue;
        const manifest=JSON.parse(await readFile(path.join(saved.workspace,"proposal.json"),"utf8"));
        const {createHash}=await import("node:crypto");
        const current=await Promise.all(manifest.proposal.changes.map(async(c:{path:string;beforeHash:string})=>{
          let bytes="";try{await noSymlinkPath(repository,path.join(repository,c.path));bytes=await readFile(path.join(repository,c.path),"utf8");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
          return createHash("sha256").update(bytes).digest("hex")===c.beforeHash;
        }));
        if(current.every(Boolean))return {...review,workspace:saved.workspace,reusedVerifiedProposal:true,metrics:{providerCalls:0}};
      }
    }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")console.warn("Cached source proposal unavailable; fresh investigation required");}
    const filesToIsolate=codeSources(failure);
    const workspace = await isolateCodeRepair(
      repository,
      {...failure,codeRepairEligible:true,evidence:[...failure.evidence,{source:"global-supervisor",detail:"Isolated investigation only; a source defect must be demonstrated by a failing regression."}]},
      filesToIsolate.slice(0, 5),
      { allowDirty: true },
    );
    const directory = path.join(workspace.root, "coding-provider");
    await mkdir(directory);
    let usage: unknown = null;
    const controller = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(policy.codeRepair.maxDurationMs)]);
    const provider = new CodexProvider({ ...settings, model: policy.codeRepair.model }, directory, {
        signal: controller, providerTimeoutMs: policy.codeRepair.maxDurationMs, maxOutputTokens: policy.codeRepair.maxOutputTokens, privacy: "full", reasoningEffort: policy.codeRepair.effort, includeCapabilityGuidance: false,
        invoke: async (adapter, req) => {
            if (Buffer.byteLength(JSON.stringify(req)) > policy.codeRepair.maxContextBytes)
                throw new Error("CODE_REPAIR_CONTEXT_BUDGET");
            const started=performance.now();let response:Awaited<ReturnType<typeof adapter.generate>>|undefined,failure:unknown;
            try{response=await new Promise((resolve,reject)=>{
              const stop=()=>reject(controller.reason??Error("CODE_REPAIR_TIMEOUT"));controller.addEventListener("abort",stop,{once:true});if(controller.aborted)stop();
              adapter.generate({...req,signal:controller}).then(resolve,reject).finally(()=>controller.removeEventListener("abort",stop));
            });}
            catch(error){failure=error;throw error;}
            finally{await onCall?.({provider:adapter.id,mode:adapter.mode,model:req.model??"provider-default",latencyMs:performance.now()-started,usage:response?.usage??null,cost:response?.estimatedCost??null,status:failure?String(failure):"SUCCESS",requestBytes:{messages:Buffer.byteLength(JSON.stringify(req.messages)),schema:Buffer.byteLength(JSON.stringify(req.responseSchema)),system:Buffer.byteLength(req.messages.filter(m=>m.role==="system").map(m=>m.content).join("")),user:Buffer.byteLength(req.messages.filter(m=>m.role==="user").map(m=>m.content).join(""))}});}
            const result=response!;
            usage = { usage: result.usage, latencyMs: result.latencyMs, estimatedCost: result.estimatedCost, model: req.model };
            if (result.toolCalls.length)
                throw new Error("CODE_REPAIR_FORBIDDEN_TOOL");
            if (result.usage && result.usage.outputTokens > req.maxOutputTokens)
                throw new Error("CODE_REPAIR_OUTPUT_BUDGET");
            if (result.usage && result.usage.inputTokens + result.usage.outputTokens > policy.codeRepair.maxTokens)
                throw new Error("CODE_REPAIR_TOKEN_BUDGET");
            if (policy.codeRepair.maxEstimatedCost !== null && result.estimatedCost !== null && result.estimatedCost > policy.codeRepair.maxEstimatedCost)
                throw new Error("CODE_REPAIR_COST_BUDGET");
            return result;
        },
    });
    const scoped = scopedCodeProposalSchema(workspace);
    const sourceContext = codeSourceContext(workspace.files, Math.floor(policy.codeRepair.maxContextBytes / 3));
    await atomicJson(path.join(workspace.root,"source-context.json"),sourceContext);
    const decision = await provider.structured({ failure: { code: failure.code, category: failure.category, stage: failure.stage, invariant: failure.invariant, evidence: failure.evidence.map(e => ({ source: e.source, detail: redactSecrets(e.detail).slice(0,2000) })) }, files: sourceContext.files.map(f=>({...f,sourceWriteAllowed:repairSourceAllowed(f.path)})), sourceContext:sourceContext.metrics, baseCommit: workspace.baseCommit, regressionPath:scoped.regressionPath, emptyFileHash:"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }, "Produce a narrow, reviewable source repair and a NEW synthetic regression test.", "You are the isolated Code Repair role, not the project agent. Read only supplied code. complete=false means exact numbered source spans, not a complete file. For existing files use unique find/replace edits on supplied exact text; never replace a partial file with full content. No shell/filesystem/network tools. Return action=propose with proposal only when evidence establishes a source defect; otherwise action=stop, proposal=null and reason. Prefer small exact find/replace edits on existing files with exact beforeHash; full content is required only for NEW regression tests. Each find must occur exactly once; new test beforeHash is SHA256 of empty text. Never change permissions, configuration, source Figma data, unrelated modules, tests already present, QA tolerances or validation to conceal a failure. Explain actual root cause; do not claim tests ran. The backend will sandbox tests. This proposal never activates itself. If the source does not establish a defect, do not invent a repair.", z.object({ action: z.enum(["propose", "stop"]), proposal: scoped.schema.nullable(), reason: z.string().max(2000) }).strict(), "code-repair");
    if (decision.action === "stop" || !decision.proposal)
        return { status: "INSUFFICIENT_EVIDENCE", reason: decision.reason, workspace: workspace.root, promotion: "DISABLED", metrics: usage };
    return finalizeCodeRepair(repository, workspace, decision.proposal, failure, {provider:usage,sourceContext:sourceContext.metrics}, controller);
}
/** Also supports verification of a previously returned proposal without another
 * provider call. It never applies a patch outside the quarantine workspace. */
export async function finalizeCodeRepair(repository:string, workspace:CodeRepairWorkspace, proposal:unknown, failure:RecoveryFailure, usage:unknown, signal?:AbortSignal) {
    const normalized = normalizeCodeProposal(workspace, proposal);
    await atomicJson(path.join(workspace.root,"proposal-normalization.json"),{version:"code-test-relocation/1",relocations:normalized.relocations,regressionTests:normalized.proposal.regressionTests,assertionsChanged:false});
    const materialized = await materializeCodeProposal(workspace, normalized.proposal), verification = await testCodeProposal(repository, materialized, signal);
    if (verification.status === "AWAITING_APPROVAL") await attestCodeRepair(repository,workspace.root);
    const locations=await safeDirectory(repository,"data/harness/code-repairs/locations");await atomicJson(path.join(locations,workspace.id+".json"),{workspace:workspace.root});
    const memoryDir = await safeDirectory(repository,"data/harness/code-repairs");
    const memoryPath = path.join(memoryDir,"index.json");
    let history: unknown[] = [];
    try { await noSymlinkPath(repository,memoryPath); const value: unknown = JSON.parse(await readFile(memoryPath,"utf8")); if (Array.isArray(value)) history = value; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    await atomicJson(memoryPath, [...history.slice(-99), {version:"code-repair-experience/1",signature:failure.signature,diagnosticFingerprint:(await import("node:crypto")).createHash("sha256").update(JSON.stringify([failure.signature,failure.stage,failure.invariant])).digest("hex"),code:failure.code,baseCommit:workspace.baseCommit,workspaceId:workspace.id,patchIdentity:materialized.patchIdentity,status:verification.status,regressionTests:normalized.proposal.regressionTests,rootCause:normalized.proposal.rootCause,verified:verification.status === "AWAITING_APPROVAL",productionApplied:false}]);
    const patch = path.join(workspace.root,"proposal.patch"), text = redactSecrets(await readFile(patch,"utf8"));
    return { ...verification, workspace: workspace.root, patch, patchPreview:text.slice(0,120000), patchPreviewTruncated:text.length>120000, normalization:normalized.relocations, metrics: usage };
}
