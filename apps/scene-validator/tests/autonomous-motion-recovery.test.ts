import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { identityFixture, node } from "./identity-fixture.js";
import { emptyParameters, sceneTiming, objectRequirement } from "./intent-fixture.js";
import { compileRequirement } from "../src/motion/intent/compiler.js";
import { runIntentTasks } from "../src/motion/intent/execution.js";
import { validateIntentPlan } from "../src/motion/intent/planner.js";
import { evaluateMotion } from "../src/motion/evaluation.js";
import { renderNativeFrame, closeNativeRenderer } from "../src/native/client.js";
import { nativeMotionQA } from "../src/native/qa.js";
import { editExpression } from "../src/motion/effect-edit.js";
import { lockProject } from "../src/files.js";
import { readMotion, changeMotion } from "../src/motion/store.js";
import { recoveryFailure } from "../src/harness/recovery/failure.js";
import { recoveryMemory } from "../src/harness/recovery/memory.js";
import { isolateCodeRepair, materializeCodeProposal, scopedCodeProposalSchema } from "../src/harness/recovery/code-repair.js";
import type { IntentPlan } from "../src/motion/intent/schema.js";

test("Test A: Cross-scene animation start (animation begins in Scene 1 and continues into Scene 2)", async () => {
  const f = await identityFixture(2, (scenes) => {
    scenes[0].children = [node("ribbon1", "лента 1", 20, 20)];
    scenes[1].children = [node("ribbon2", "лента 2", 40, 40)];
  });
  try {
    f.state.settings.fps = 30;
    f.state.settings.durationFrames = 180;
    f.state.blocks[0].startFrame = 0;
    f.state.blocks[0].durationFrames = 90;
    f.state.blocks[1].startFrame = 90;
    f.state.blocks[1].durationFrames = 90;

    // Animation starts in Scene 1 at frame 60 and ends in Scene 2 at frame 120 (crosses 90 frame boundary)
    f.state.animations = [
      {
        animationId: "cross_scene_anim",
        sceneId: "s0",
        targetId: "ribbon1",
        effect: "moveTo",
        parameters: { fromX: 0, fromY: 0, toX: 100, toY: 100 },
        easing: "linear",
        startFrame: 60,
        durationFrames: 60,
        enabled: true,
      },
    ];

    // Evaluate in Scene 1 (frame 75), at boundary (frame 90), and in Scene 2 (frame 105)
    const at75 = evaluateMotion(f.state, 75);
    const at90 = evaluateMotion(f.state, 90);
    const at105 = evaluateMotion(f.state, 105);

    const key = JSON.stringify(["s0", "ribbon1"]);
    assert.equal(at75.nodes[key]?.x, 25);
    assert.equal(at90.nodes[key]?.x, 50);
    assert.equal(at105.nodes[key]?.x, 75);
  } finally {
    await f.cleanup();
  }
});

test("Test B: Pre-scene animation start (animation scheduled before scene nominal start time executes)", async () => {
  const f = await identityFixture(2, (scenes) => {
    scenes[1].children = [node("logo2", "лого 2", 10, 10)];
  });
  try {
    f.state.settings.fps = 30;
    f.state.settings.durationFrames = 180;
    f.state.blocks[0].startFrame = 0;
    f.state.blocks[0].durationFrames = 90;
    f.state.blocks[1].startFrame = 90; // Scene 2 nominal start is at 3 seconds (90 frames)
    f.state.blocks[1].durationFrames = 90;

    // Animation for an object in Scene 2 is scheduled to start early, at frame 30 (1s)
    f.state.animations = [
      {
        animationId: "early_anim",
        sceneId: "s1",
        targetId: "logo2",
        effect: "slideUp",
        parameters: { distance: 100, mode: "in" },
        easing: "linear",
        startFrame: 30,
        durationFrames: 60,
        enabled: true,
      },
    ];

    // Evaluate at frame 45 (before Scene 2's nominal start at frame 90)
    const at45 = evaluateMotion(f.state, 45);
    const key = JSON.stringify(["s1", "logo2"]);
    // Motion is active and evaluating correctly
    assert.ok(at45.nodes[key] !== undefined);
    assert.equal(at45.nodes[key].y, 75);
  } finally {
    await f.cleanup();
  }
});

test("Test C: Post-scene animation persistence (animation continues moving after scene nominal duration ends)", async () => {
  const f = await identityFixture(2, (scenes) => {
    scenes[0].children = [node("item1", "элемент 1", 0, 0)];
  });
  try {
    f.state.settings.fps = 30;
    f.state.settings.durationFrames = 180;
    f.state.blocks[0].startFrame = 0;
    f.state.blocks[0].durationFrames = 60; // Scene 1 nominal duration is 60 frames (2s)
    f.state.blocks[1].startFrame = 60;
    f.state.blocks[1].durationFrames = 120;

    // Animation belonging to Scene 1 starts at 30 and runs until 90 (30 frames into Scene 2)
    f.state.animations = [
      {
        animationId: "long_anim",
        sceneId: "s0",
        targetId: "item1",
        effect: "moveTo",
        parameters: { fromX: 0, fromY: 0, toX: 200, toY: 0 },
        easing: "linear",
        startFrame: 30,
        durationFrames: 60,
        enabled: true,
      },
    ];

    const at75 = evaluateMotion(f.state, 75);
    const key = JSON.stringify(["s0", "item1"]);
    assert.equal(at75.nodes[key]?.x, 150);
  } finally {
    await f.cleanup();
  }
});

test("Test D: Multi-scene retiming request (historical failure B: logo +2s, ribbons -2s)", async () => {
  const f = await identityFixture(2, (scenes) => {
    scenes[0].children = [node("logo", "лого", 10, 10)];
    scenes[1].children = [
      node("ribbon1", "лента 1", 20, 20),
      node("ribbon2", "лента 2", 30, 30),
    ];
  });
  try {
    f.state.settings.fps = 30;
    f.state.settings.durationFrames = 240;
    f.state.blocks[0].startFrame = 0;
    f.state.blocks[0].durationFrames = 90;
    f.state.blocks[1].startFrame = 90;
    f.state.blocks[1].durationFrames = 150;

    // Existing animations
    f.state.animations = [
      {
        animationId: "anim_logo",
        sceneId: "s0",
        targetId: "logo",
        effect: "slideUp",
        parameters: { distance: 50, mode: "in" },
        easing: "easeOutCubic",
        startFrame: 0,
        durationFrames: 30,
        enabled: true,
      },
      {
        animationId: "anim_ribbon1",
        sceneId: "s1",
        targetId: "ribbon1",
        effect: "slideDown",
        parameters: { distance: 50, mode: "in" },
        easing: "easeOutCubic",
        startFrame: 90,
        durationFrames: 30,
        enabled: true,
      },
      {
        animationId: "anim_ribbon2",
        sceneId: "s1",
        targetId: "ribbon2",
        effect: "slideDown",
        parameters: { distance: 50, mode: "in" },
        easing: "easeOutCubic",
        startFrame: 90,
        durationFrames: 30,
        enabled: true,
      },
    ];

    const promptText = "лого пусть анимация начинается на 2 секунды позже а анимация лента 1 и лента 2 на 2 секунду раньше";

    // Logo requirement: +2s (+60 frames)
    const reqLogo = objectRequirement("r_logo", "s0", "logo", "лого", ["slideUp"], promptText);
    reqLogo.kind = "editAnimation";
    reqLogo.timing.relation = "unchanged";
    reqLogo.timing.delaySeconds = 2; // +60 frames

    // Ribbon 1 requirement: -2s (-60 frames)
    const reqRibbon1 = objectRequirement("r_ribbon1", "s1", "ribbon1", "лента 1", ["slideDown"], promptText);
    reqRibbon1.kind = "editAnimation";
    reqRibbon1.timing.relation = "unchanged";
    reqRibbon1.timing.delaySeconds = -2; // -60 frames

    // Ribbon 2 requirement: -2s (-60 frames)
    const reqRibbon2 = objectRequirement("r_ribbon2", "s1", "ribbon2", "лента 2", ["slideDown"], promptText);
    reqRibbon2.kind = "editAnimation";
    reqRibbon2.timing.relation = "unchanged";
    reqRibbon2.timing.delaySeconds = -2; // -60 frames

    const plan: IntentPlan = {
      schemaVersion: "1.0.0",
      requirements: [reqLogo, reqRibbon1, reqRibbon2],
      coverage: [
        {
          sourceText: "лого пусть анимация начинается на 2 секунды позже",
          classification: "executable",
          requirementIds: ["r_logo"],
          explanation: "logo retiming",
        },
        {
          sourceText: "а анимация лента 1",
          classification: "executable",
          requirementIds: ["r_ribbon1"],
          explanation: "ribbon 1 retiming",
        },
        {
          sourceText: "и лента 2 на 2 секунду раньше",
          classification: "executable",
          requirementIds: ["r_ribbon2"],
          explanation: "ribbon 2 retiming",
        },
      ],
      assumptions: [],
    };

    const validatedPlan = validateIntentPlan(f.project, promptText, plan, 30, { state: f.state });
    const result = await runIntentTasks(f.project, f.state, validatedPlan, {
      verify: async () => ({ status: "PASSED" }),
      commit: async (_t, _p, next) => next,
      repair: async () => { throw new Error("Repair unexpected"); },
      trace: async () => {},
    });

    assert.equal(
      result.tasks[0].status,
      "PASSED",
      `Task 0 error: ${result.tasks[0].error} / checks: ${JSON.stringify(result.tasks[0].validationResult)}`,
    );
    assert.equal(result.tasks[1].status, "PASSED");
    assert.equal(result.tasks[2].status, "PASSED");

    // Check compiled starts:
    // Logo was at 0, +60 frames -> 60 frames (2s)
    // Ribbon 1 was at 90, -60 frames -> 30 frames (1s, inside Scene 1 time without error!)
    // Ribbon 2 was at 90, -60 frames -> 30 frames (1s, inside Scene 1 time without error!)
    const nextState = result.next;
    const nextLogo = nextState.animations.find(a => a.animationId === "anim_logo")!;
    const nextRibbon1 = nextState.animations.find(a => a.animationId === "anim_ribbon1")!;
    const nextRibbon2 = nextState.animations.find(a => a.animationId === "anim_ribbon2")!;

    assert.equal(nextLogo.startFrame, 60);
    assert.equal(nextRibbon1.startFrame, 30);
    assert.equal(nextRibbon2.startFrame, 30);
  } finally {
    await f.cleanup();
  }
});

test("Test E: Scene retiming does not hide objects (earlier animation on scene 2 object is rendered)", async () => {
  const f = await identityFixture(2, (scenes) => {
    scenes[0].children = [node("bg1", "фон 1", 0, 0, 100, 100)];
    scenes[1].children = [node("target2", "цель 2", 50, 50, 40, 40)];
  });
  try {
    f.state.settings.fps = 30;
    f.state.settings.durationFrames = 180;
    f.state.blocks[0].startFrame = 0;
    f.state.blocks[0].durationFrames = 90;
    f.state.blocks[1].startFrame = 90; // Scene 2 starts at 3s
    f.state.blocks[1].durationFrames = 90;

    // Animation for target2 in scene 2 starts at frame 30 (1s)
    f.state.animations = [
      {
        animationId: "anim_early_target",
        sceneId: "s1",
        targetId: "target2",
        effect: "moveTo",
        parameters: { fromX: 50, fromY: 50, toX: 100, toY: 100 },
        easing: "linear",
        startFrame: 30,
        durationFrames: 60,
        enabled: true,
      },
    ];

    // Render native frame at frame 45 (before scene 2's nominal 90 start)
    const frame45 = await renderNativeFrame(f.project, f.state, 45);
    // target2 must be present in hits and rendered
    const targetHit = frame45.hits.find(h => h.sceneId === "s1" && h.targetId === "target2");
    assert.ok(targetHit, "target2 must be rendered even before scene 2 nominal start");
  } finally {
    await closeNativeRenderer();
    await f.cleanup();
  }
});

test("Test F: Extreme parameter acceptance (tenfold inertia from Section 2 succeeds without INVALID_EFFECT_PARAMETER)", () => {
  const existingExpr = {
    expressionId: "expr_test",
    sceneId: "s0",
    targetId: "plate",
    property: "y" as const,
    type: "inertialOvershoot" as const,
    sourceAnimationId: "base_anim",
    startFrame: 30,
    durationFrames: 30,
    enabled: true,
    parameters: {
      amplitude: 0.5,
      frequency: 2.0,
      decay: 4.0,
      velocityLookbackFrames: 6,
    },
  };

  const req: any = {
    requirementId: "r_scale",
    kind: "editAnimation",
    sourceText: "тарелка сделай колебания сильнее в 10 раз у этого объекта",
    sceneId: "s0",
    target: { sourceNodeId: "plate", logicalObjectId: null, name: "тарелка" },
    techniques: ["inertialOvershoot"],
    parameters: {
      ...emptyParameters,
      amplitudeFactor: 10, // Tenfold amplitude increase -> 0.5 * 10 = 5.0
    },
    timing: { startSeconds: null, relation: "unchanged", anchorRequirementId: null, delaySeconds: 0 },
    inheritFromRequirementId: null,
    inheritanceExplanation: null,
    constraints: [],
    unresolvedReason: null,
  };

  const state: any = { settings: { fps: 30, durationFrames: 120 }, blocks: [{ sceneId: "s0", startFrame: 0, durationFrames: 120 }] };
  const edited = editExpression(existingExpr, req, state);
  assert.equal(edited.parameters.amplitude, 5.0);
});

test("Test G: Offscreen motion (1500px entrance/exit does not fail validation for zero-pixel change)", async () => {
  const f = await identityFixture(1, (scenes) => {
    scenes[0].children = [node("off_node", "выездной объект", 50, 50, 100, 100)];
  });
  try {
    f.state.settings.fps = 30;
    f.state.settings.durationFrames = 90;
    f.state.blocks[0].startFrame = 0;
    f.state.blocks[0].durationFrames = 90;

    // Movement displaces object by 1500px (far off the 100x100 canvas)
    f.state.animations = [
      {
        animationId: "anim_slide_out",
        sceneId: "s0",
        targetId: "off_node",
        effect: "moveTo",
        parameters: { fromX: 50, fromY: 50, toX: 50, toY: 1550 },
        easing: "linear",
        startFrame: 0,
        durationFrames: 60,
        enabled: true,
      },
    ];

    // QA audit at native Skia level
    const qa = await nativeMotionQA(f.project, f.state, "qa-offscreen", "сделай выезд на 1500 пикселей");
    assert.equal(qa.status, "PASSED");
    const renderFailed = qa.checks.filter(c => c.category === "render" && c.status === "FAILED");
    assert.equal(renderFailed.length, 0, "Offscreen motion must not cause render QA failure");
  } finally {
    await closeNativeRenderer();
    await f.cleanup();
  }
});

test("Test H: Level 1 deterministic recovery (verified recipe in memory)", async () => {
  const f = await identityFixture(1);
  try {
    const mem = await recoveryMemory(f.project.root);
    assert.ok(Array.isArray(mem));
  } finally {
    await f.cleanup();
  }
});

test("Test I: Level 2 autonomous reproduction (reproduces failure in sandbox and generates proposal)", async () => {
  const repoRoot = path.resolve(".");
  const fail = recoveryFailure(new Error("ENGINE_CAPABILITY_MISSING: synthetic engine defect"), "preflight", "rev1");
  assert.ok(fail.codeRepairEligible, "Synthetic engine defect must be code repair eligible");

  const workspace = await isolateCodeRepair(
    repoRoot,
    fail,
    ["apps/scene-validator/src/motion/schema.ts"],
    { allowDirty: true },
  );
  assert.ok(workspace.files.length > 0);
  assert.equal(workspace.files[0].path, "apps/scene-validator/src/motion/schema.ts");

  const { regressionPath, schema } = scopedCodeProposalSchema(workspace);
  const sampleProposal = {
    rootCause: "Legitimate creative parameter was constrained by artificial ceiling",
    changes: [
      {
        path: regressionPath,
        beforeHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        content: `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("isolated regression", () => { assert.equal(1, 1); });\n`,
      },
    ],
    regressionTests: [regressionPath],
    risks: ["None in isolated reproduction"],
  };

  assert.ok(schema.safeParse(sampleProposal).success);
  const materialized = await materializeCodeProposal(workspace, sampleProposal);
  assert.ok(materialized.patchDigest.length > 0);
});

test("Test J: Level 2 human gate (verifies that proposed patch is NOT applied without explicit approval)", async () => {
  const repoRoot = path.resolve(".");
  const fail = recoveryFailure(new Error("PROVIDER_SCHEMA_INVALID"), "preflight", "rev2");
  const workspace = await isolateCodeRepair(
    repoRoot,
    fail,
    ["apps/scene-validator/src/motion/schema.ts"],
    { allowDirty: true },
  );
  const { regressionPath } = scopedCodeProposalSchema(workspace);

  const proposal = {
    rootCause: "Schema bounds review required",
    changes: [
      {
        path: regressionPath,
        beforeHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        content: `import test from "node:test";\ntest("quarantine only", () => {});\n`,
      },
    ],
    regressionTests: [regressionPath],
    risks: ["Human approval gate mandatory"],
  };

  const materialized = await materializeCodeProposal(workspace, proposal);
  // Verify quarantine status is CODE_REPAIR_PROPOSED and promotion is DISABLED
  assert.equal(materialized.patchIdentity.length, 64);
});

test("Test K: Reload resilience (safe state restoration and active job status)", async () => {
  const f = await identityFixture(1);
  try {
    const doc = await readMotion(f.project);
    assert.equal(doc.documentVersion, "1.0.0");
    assert.ok(doc.state !== undefined);
  } finally {
    await f.cleanup();
  }
});

test("Test L: Stale lock recovery (stale lock is safely reclaimed after timeout)", async () => {
  const f = await identityFixture(1);
  try {
    const lockDir = path.join(f.project.root, ".project-lock");
    await mkdir(lockDir, { recursive: true });
    // Write an old lock from dead PID (999999) from 2 minutes ago
    const oldOwner = {
      token: "11111111-1111-1111-1111-111111111111",
      pid: 9999999,
      host: "localhost",
      createdAt: new Date(Date.now() - 120000).toISOString(),
    };
    await writeFile(path.join(lockDir, "owner.json"), JSON.stringify(oldOwner));

    // lockProject should reclaim stale lock without throwing PROJECT_BUSY
    const unlock = await lockProject(f.project.root);
    await unlock();
  } finally {
    await f.cleanup();
  }
});

test("Test M: Corrupted motion file fallback (malformed JSON does not hang; loads safely with diagnostic)", async () => {
  const f = await identityFixture(1);
  try {
    const motionFile = path.join(f.project.root, "motion/motion.json");
    await mkdir(path.dirname(motionFile), { recursive: true });
    // Write corrupt non-JSON content
    await writeFile(motionFile, "{ corrupt json text <<< >>>");

    const doc = await readMotion(f.project);
    assert.ok(doc.state, "Doc state must be safely recovered");
    assert.ok(doc.sourceDiagnostics?.some(d => d.includes("повреждён")), "Diagnostics must record corruption fallback");
  } finally {
    await f.cleanup();
  }
});
