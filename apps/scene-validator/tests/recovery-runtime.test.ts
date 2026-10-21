import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { identityFixture, node } from "./identity-fixture.js";
import { objectRequirement } from "./intent-fixture.js";
import { recoveryFailure } from "../src/harness/recovery/failure.js";
import { recoveryPolicySchema } from "../src/harness/recovery/config.js";
import { recoverPreflight } from "../src/harness/recovery/runtime.js";
import { rememberRecovery, recoveryMemory } from "../src/harness/recovery/memory.js";
import { codeProposalSchema, isolateCodeRepair, materializeCodeProposal, testCodeProposal, promoteCodeRepair, reviewCodeRepair } from "../src/harness/recovery/code-repair.js";
import { compileTasks } from "../src/motion/intent/compiler.js";
import { preflightIntentPlan } from "../src/motion/intent/execution.js";
import { motionStateDigest } from "../src/motion/tools.js";
import { applyOperations } from "../src/motion/operations.js";
const exec = promisify(execFile), sha = (s: string) => createHash("sha256").update(s).digest("hex");
test("recovery failure taxonomy does not equate ambiguity, missing geometry or failed tasks with a code defect", () => {
    for (const [code, category] of [["OBJECT_NOT_FOUND", "STALE_REFERENCE"], ["AMBIGUOUS_TARGET", "AMBIGUITY"], ["ANIMATION_NOT_FOUND", "MISSING_ANIMATION"], ["INVALID_LIFECYCLE_INTERVAL", "TIMELINE_CONFLICT"], ["DEPENDENT_EFFECTS_REQUIRE_POLICY", "DEPENDENCY_CONFLICT"], ["NATIVE_RENDER_FAILURE", "RENDERER_FAILURE"], ["COMPILER_COVERAGE_ERROR", "PROBABLE_DEFECT"]])
        assert.equal(recoveryFailure({ code }, "preflight", "r").category, category);
    assert.equal(recoveryFailure({ code: "AMBIGUOUS_TARGET" }, "preflight", "r").codeRepairEligible, false);
    assert.equal(recoveryFailure({ code: "MISSING_PATH_GEOMETRY" }, "preflight", "r").codeRepairEligible, false);
    assert.equal(recoveryFailure({ code: "COMPILER_COVERAGE_ERROR" }, "preflight", "r").codeRepairEligible, true);
});
async function fixture() {
    const f = await identityFixture(1, s => { s[0].children = [node("p", "Product", 40, 40), node("other", "Other", 100, 60)]; });
    f.state.settings.durationFrames = 60;
    f.state.blocks[0].durationFrames = 60;
    f.state.animations = [{ animationId: "base", sceneId: "s0", targetId: "p", effect: "slideUp", parameters: { distance: 30, mode: "in" }, enabled: true, easing: "linear", startFrame: 3, durationFrames: 12 }];
    const r = objectRequirement("r", "s0", "p", "Product", ["slideUp"], "Product быстрее");
    r.kind = "editAnimation";
    r.effectOperation = { storage: "animation", action: "updateTiming" };
    r.animationIds = ["base"];
    r.parameters.durationFactor = .5;
    r.timing.relation = "unchanged";
    const plan = { schemaVersion: "1.0.0" as const, requirements: [r], coverage: [{ sourceText: r.sourceText, requirementIds: ["r"], classification: "executable" as const, explanation: "fixture" }], assumptions: [] };
    return { ...f, plan };
}
test("targeted typed-tool recovery is admitted against original intent; duplicate failing actions stop without persistence", async () => {
    const f = await fixture();
    try {
        const task = compileTasks(f.project, f.plan)[0];
        // Controlled compiler defect evidence: valid intended duration edit but compiler could not lower it.
        const error = Object.assign(new Error("COMPILER_COVERAGE_ERROR"), { report: { code: "COMPILER_COVERAGE_ERROR", taskId: task.taskId, reports: [] } });
        const before = motionStateDigest(f.state);
        let calls = 0;
        const result = await recoverPreflight(f.project, f.state, f.plan, error, { request: "Product быстрее", revision: "r1", policy: recoveryPolicySchema.parse({}), checkpoint: () => { }, record: async () => { }, decide: async () => { calls++; return { action: "apply", reason: "same duration factor using actual tool", commands: [{ tool: "updateAnimation", animationId: "base", patch: { durationFrames: 6 } }] }; } });
        assert.equal(result.report.status, "Candidate Recovered");
        assert.equal(calls, 1);
        assert.equal(before, motionStateDigest(f.state));
        const operations = [...result.prepared.preparedPlans.values()].flatMap(p => p.compiled.operations);
        const after = applyOperations(f.state, operations, f.project);
        assert.equal(after.animations[0].startFrame, 3);
        assert.equal(after.animations[0].durationFrames, 6);
        calls = 0;
        await assert.rejects(() => recoverPreflight(f.project, f.state, f.plan, error, { request: "Product быстрее", revision: "r1", policy: recoveryPolicySchema.parse({}), checkpoint: () => { }, record: async () => { }, decide: async () => { calls++; return { action: "apply", reason: "bad edit", commands: [{ tool: "updateAnimation", animationId: "base", patch: { durationFrames: 5 } }] }; } }), /RECOVERY_DUPLICATE_ACTION/);
        assert.equal(calls, 2);
        assert.equal(before, motionStateDigest(f.state));
    }
    finally {
        await f.cleanup();
    }
});
test("recovery rejects writes outside original target and rejects arbitrary shell tools", async () => {
    const f = await fixture();
    try {
        const task = compileTasks(f.project, f.plan)[0];
        const error = Object.assign(new Error("COMPILER_COVERAGE_ERROR"), { report: { code: "COMPILER_COVERAGE_ERROR", taskId: task.taskId, reports: [] } });
        await assert.rejects(() => recoverPreflight(f.project, f.state, f.plan, error, { request: "Product быстрее", revision: "r1", policy: recoveryPolicySchema.parse({ maxAttempts: 1 }), checkpoint: () => { }, record: async () => { }, decide: async () => ({ action: "apply", reason: "unrelated", commands: [{ tool: "createAnimation", animation: { ...f.state.animations[0], animationId: "foreign", targetId: "other" } }] }) }), /RECOVERY_ATTEMPT_LIMIT/);
        const { recoveryDecisionSchema } = await import("../src/harness/recovery/runtime.js");
        assert.equal(recoveryDecisionSchema.safeParse({ action: "apply", commands: [{ tool: "shell", command: "anything" }], reason: "x" }).success, false);
    }
    finally {
        await f.cleanup();
    }
});
test("recovery memory is compact, versioned and cannot promote arbitrary procedures to executable VERIFIED recipes", async () => {
    const f = await fixture();
    try {
        const sig = sha("failure");
        await rememberRecovery(f.project.root, sig, "canonical-reference-rebind/1", true);
        await rememberRecovery(f.project.root, sig, "canonical-reference-rebind/1", false);
        await rememberRecovery(f.project.root, sig, "model-supplied-code", true);
        const rows = await recoveryMemory(f.project.root);
        assert.equal(rows.find(r => r.procedure === "model-supplied-code")!.status, "TESTED");
        assert.equal(rows.find(r => r.procedure === "canonical-reference-rebind/1")!.successes, 1);
        assert.ok(!JSON.stringify(rows).includes("Product"));
    }
    finally {
        await f.cleanup();
    }
});
test("Level 2 quarantines an injected defect, enforces path/hash/OS boundaries and NEVER promotes its patch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "akella-repair-fixture-"));
    let quarantine: string | undefined;
    try {
        await mkdir(path.join(root, "apps/scene-validator/src/motion"), { recursive: true });
        await mkdir(path.join(root, "apps/scene-validator/tests"), { recursive: true });
        const file = "apps/scene-validator/src/motion/tools.ts", original = "export const duration = (n: number) => n + 1;\n";
        await writeFile(path.join(root, file), original);
        await writeFile(path.join(root, "package.json"), '{"type":"module"}');
        await writeFile(path.join(root, ".gitignore"), 'node_modules\n');
        await writeFile(path.join(root, "tsconfig.check.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: true, types: ["node"], allowImportingTsExtensions: true }, include: ["apps/**/*.ts"] }));
        await symlink(path.resolve("node_modules"), path.join(root, "node_modules"));
        await exec("git", ["init", "-q"], { cwd: root });
        await exec("git", ["add", "apps", "package.json", "tsconfig.check.json", ".gitignore"], { cwd: root });
        await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "synthetic defective baseline"], { cwd: root });
        const failure = recoveryFailure({ code: "COMPILER_COVERAGE_ERROR" }, "preflight", "r");
        const ws = await isolateCodeRepair(root, failure, [file]);
        quarantine = ws.root;
        await assert.rejects(() => materializeCodeProposal(ws, { rootCause: "bug", changes: [{ path: "../escape", beforeHash: sha(""), content: "x" }], regressionTests: ["apps/scene-validator/tests/regression.test.ts"], risks: [] }), /path|scope/i);
        const testPath = "apps/scene-validator/tests/recovery-injected.test.ts";
        const regression = `import test from 'node:test';import assert from 'node:assert/strict';import {duration} from '../src/motion/tools.ts';import {readFileSync,writeFileSync} from 'node:fs';import net from 'node:net';\ntest('fixed duration and real confinement',async()=>{assert.equal(duration(3),3);assert.throws(()=>writeFileSync(${JSON.stringify(path.join(root, "forbidden"))},'bad'));assert.throws(()=>readFileSync(${JSON.stringify(path.join(root, file))},'utf8'));await new Promise<void>((resolve,reject)=>{const s=net.connect({host:'127.0.0.1',port:4173});s.on('error',(error:NodeJS.ErrnoException)=>{try{assert.ok(['EPERM','EACCES'].includes(error.code??''));resolve()}catch(e){reject(e)}});s.on('connect',()=>{s.destroy();reject(Error('network escaped sandbox'))});});});\n`;
        const proposal = codeProposalSchema.parse({ rootCause: "Injected test-only +1 violates exact duration", changes: [{ path: file, beforeHash: sha(original), edits: [{ find: "n + 1", replace: "n" }] }, { path: testPath, beforeHash: sha(""), content: regression }], regressionTests: [testPath], risks: ["Synthetic fixture only"] });
        const materialized = await materializeCodeProposal(ws, proposal);
        assert.equal(await readFile(path.join(root, file), "utf8"), original);
        const report = await testCodeProposal(root, materialized);
        if (process.platform === "darwin")
            assert.equal(report.status, "AWAITING_APPROVAL", JSON.stringify(report));
        else
            assert.equal(report.status, "BLOCKED");
        const reviewed = await reviewCodeRepair(ws.root);
        assert.equal(reviewed.automaticPromotionAvailable, false);
        await writeFile(path.join(ws.root, "proposal.patch"), "tampered");
        await assert.rejects(() => reviewCodeRepair(ws.root), /CODE_REPAIR_DIFF_CHANGED/);
        assert.throws(() => promoteCodeRepair(), /CODE_PROMOTION_DISABLED/);
        assert.equal(await readFile(path.join(root, file), "utf8"), original);
    }
    finally {
        await rm(root, { recursive: true, force: true });
        if (quarantine)
            await rm(quarantine, { recursive: true, force: true });
    }
});

test("verified deterministic reference rebind uses original unique name and no model call", async () => {
 const f=await fixture();try{
  f.plan.requirements[0].target.sourceNodeId="stale-id";
  let error:unknown;try{preflightIntentPlan(f.project,f.state,f.plan);}catch(e){error=e;}
  assert.ok(error);let calls=0;
  const result=await recoverPreflight(f.project,f.state,f.plan,error,{request:"Product быстрее",revision:"r1",policy:recoveryPolicySchema.parse({}),checkpoint:()=>{},record:async()=>{},decide:async()=>{calls++;throw Error("unexpected provider call")}});
  assert.equal(calls,0);assert.equal(result.plan.requirements[0].target.sourceNodeId,"p");assert.equal(result.report.procedure,"canonical-reference-rebind/1");
 }finally{await f.cleanup()}
});
