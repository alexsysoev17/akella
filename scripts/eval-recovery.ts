/** Opt-in hybrid qualification: saved faulty semantics, then ONE real Codex recovery call.
 * Synthetic scenes only. This is not a live semantic-planning benchmark. */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { identityFixture, node } from "../apps/scene-validator/tests/identity-fixture.ts";
import { logicalId } from "../apps/scene-validator/src/motion/registry.ts";
import { registerProvider } from "../apps/scene-validator/src/harness/providers/index.ts";
import { CodexAdapter } from "../apps/scene-validator/src/harness/providers/codex.ts";
import { readMotion, changeMotion } from "../apps/scene-validator/src/motion/store.ts";
import { executeMotion } from "../apps/scene-validator/src/motion/service.ts";
import { closeNativeRenderer } from "../apps/scene-validator/src/native/client.ts";
import { recoveryPolicySchema } from "../apps/scene-validator/src/harness/recovery/config.ts";
if (!process.argv.includes("--live"))
    throw Error("Requires explicit --live; synthetic data only");
process.env.AKELLA_RENDERER = "native";
const f = await identityFixture(2, scenes => scenes.forEach((s, i) => { s.children = [node("c" + i, "Circle", 30 + i * 70, 40)]; }));
let calls = 0;
const typed = process.argv.includes("--typed");
const prompt = typed ? "Удали движение Circle вместе с зависимой инерцией. Другие объекты не меняй." : "Убери всю анимацию Circle вместе с зависимыми эффектами. Другие объекты не меняй.";
const action = typed
    ? {actionId:"a",clauseId:"c",kind:"editAnimation",scene:"s0",targets:["c0"],techniques:["slideUp"],parameters:[],effectOperation:{storage:"animation",action:"remove"},constraints:[],unresolvedReason:null}
    : { actionId: "a", clauseId: "c", kind: "unsupported", scene: null, targets: ["Circle"], targetScope: "logicalObject", techniques: ["objectStateTransition"], parameters: [], constraints: [], unresolvedReason: "old capability contract incorrectly rejected transition removal" };
const faulty = { schemaVersion: "semantic-graph/1.0", clauses: [{ clauseId: "c", text: prompt }], actions: [action], assumptions: [] };
const stop = registerProvider("hybrid-recovery-qualification", dir => ({ id: "hybrid-recovery-qualification", get mode() { return calls === 0 ? "mock" as const : "live" as const; }, capabilities: () => ({ structuredOutput: true, nativeToolCalling: false, cancellation: true, usage: true, nativeOutputTokenLimit: false }), generate: async (request) => ++calls === 1 ? { output: faulty, usage: null, estimatedCost: null, latencyMs: 0, diagnostics: ["intentionally prepared unsupported semantic plan; not a live planner"], toolCalls: [] } : new CodexAdapter("codex-sdk", dir).generate(request) }));
try {
    const doc = await readMotion(f.project);
    f.state.settings.durationFrames = 48;
    f.state.blocks.forEach((b, i) => { b.startFrame = i * 24; b.durationFrames = 24; });
    await changeMotion(f.project.root, { expectedRevision: doc.revision, request: "synthetic setup", operations: [{ type: "setProjectSettings", settings: f.state.settings }, { type: "setBlocks", blocks: f.state.blocks }, ...(typed ? [
        {type:"addAnimation" as const,animation:{animationId:"circle-base",sceneId:"s0",targetId:"c0",effect:"slideUp" as const,startFrame:0,durationFrames:12,easing:"linear" as const,enabled:true,parameters:{distance:30,mode:"in" as const}}},
        {type:"setExpression" as const,expression:{expressionId:"circle-inertia",sceneId:"s0",targetId:"c0",type:"inertialOvershoot" as const,property:"y" as const,sourceAnimationId:"circle-base",startFrame:12,durationFrames:12,enabled:true,parameters:{mode:"ae" as const,amplitude:.2,frequency:2.5,decay:3,velocityLookbackFrames:3}}},
    ] : [{ type: "animateObjectStateTransition" as const, transitionId: "circle-transition", logicalObjectId: logicalId("Circle"), fromSceneId: "s0", toSceneId: "s1", timelinePolicy: "referenceStates" as const, startFrame: 0, durationFrames: 12, easing: "linear" as const, proceduralEffects: [], layerPolicy: { type: "switch" as const, switchProgress: 1 } }])] });
    const before = await readMotion(f.project), result = await executeMotion(f.project, { mode: "edit", request: prompt, expectedRevision: before.revision, settings: { provider: "hybrid-recovery-qualification", model: "" } }, stage => console.error(stage), { config: { maxLLMCalls: 2, maxRepairAttempts: 1, ...(typed ? {recovery:recoveryPolicySchema.parse({maxTokens:40000})} : {}) } });
    const report = { qualification: "prepared semantic failure + live Codex recovery + production native QA and atomic commit", project: f.project.root, runId: result.id, status: result.reconciliation?.status, calls, recovery: JSON.parse(await readFile(path.join(f.project.root, "motion/ai", result.id, "recovery.json"), "utf8")) };
    await writeFile(path.join(f.root, "live-recovery-report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (result.reconciliation?.status !== "SUCCESS")
        process.exitCode = 1;
}
finally {
    stop();
    await closeNativeRenderer();
}
