import test from "node:test";
import assert from "node:assert/strict";
import { identityFixture, node } from "./identity-fixture.js";
import { objectRequirement } from "./intent-fixture.js";
import { resolveBaseMotion } from "../src/motion/base-motion.js";
import { validateIntentPlan } from "../src/motion/intent/planner.js";
import {
  compileTasks,
  compileRequirement,
} from "../src/motion/intent/compiler.js";
import { applyOperations } from "../src/motion/operations.js";
import type { Animation } from "../src/motion/schema.js";
import type { IntentPlan } from "../src/motion/intent/schema.js";
const prompt =
  "image текст куар лого пусть у этих объектов будут небольшие затухающие колебания после конца анимации по позиции";
async function fixture() {
  const f = await identityFixture(1, (s) => {
    s[0].children = ["image", "текст", "куар", "лого"].map((n, i) =>
      node("n" + i, n, 10 + i * 30, 20),
    );
  });
  f.state.settings.fps = 30;
  f.state.settings.durationFrames = 150;
  f.state.blocks[0].durationFrames = 150;
  f.state.animations = [
    {
      animationId: "a0",
      sceneId: "s0",
      targetId: "n0",
      effect: "slideUp",
      parameters: { distance: 80, mode: "in" },
      startFrame: 0,
      durationFrames: 21,
      easing: "easeOutCubic",
      enabled: true,
    },
    {
      animationId: "a1",
      sceneId: "s0",
      targetId: "n1",
      effect: "slideDown",
      parameters: { distance: 40, mode: "in" },
      startFrame: 2,
      durationFrames: 30,
      easing: "linear",
      enabled: true,
    },
    {
      animationId: "a2",
      sceneId: "s0",
      targetId: "n2",
      effect: "moveTo",
      parameters: { fromX: 0, toX: 10, fromY: 0, toY: 40 },
      startFrame: 0,
      durationFrames: 25,
      easing: "easeOutQuad",
      enabled: true,
    },
    {
      animationId: "a3",
      sceneId: "s0",
      targetId: "n3",
      effect: "keyframes",
      parameters: {
        property: "y",
        points: [
          { frame: 0, value: 50 },
          { frame: 20, value: 0 },
        ],
      },
      startFrame: 0,
      durationFrames: 20,
      easing: "linear",
      enabled: true,
    },
  ] as Animation[];
  return f;
}
function plan(): IntentPlan {
  return {
    schemaVersion: "1.0.0",
    requirements: ["image", "текст", "куар", "лого"].map((name, i) => {
      const r = objectRequirement(
        "r" + i,
        "s0",
        "n" + i,
        name,
        ["inertialOvershoot"],
        prompt,
      );
      r.kind = "unsupported";
      r.target.sourceNodeId = null;
      r.unresolvedReason = "Existing base track not found in supplied context";
      r.timing.relation = "unchanged";
      return r;
    }),
    coverage: [
      {
        sourceText: prompt,
        requirementIds: ["r0", "r1", "r2", "r3"],
        classification: "unsupported",
        explanation: "mock saved plan",
      },
    ],
    assumptions: [],
  };
}
test("authoritative position resolver recovers four unsupported inertia attachments without editing base tracks or easing", async () => {
  const f = await fixture();
  try {
    const p = validateIntentPlan(f.project, prompt, plan(), 30, {
      state: f.state,
    });
    assert.ok(
      p.requirements.every(
        (r) => r.kind === "objectAnimation" && r.unresolvedReason === null,
      ),
    );
    let state = f.state;
    for (const task of compileTasks(f.project, p))
      state = applyOperations(
        state,
        compileRequirement(f.project, state, p, task).operations,
        f.project,
      );
    assert.deepEqual(state.animations, f.state.animations);
    assert.equal(state.expressions?.length, 5);
    for (let i = 0; i < 4; i++) {
      const base = resolveBaseMotion(state, "s0", "n" + i);
      assert.equal(base.status, "RESOLVED");
      assert.ok(
        Object.values(base.tracks[0].incomingVelocity).some((v) => v !== 0),
      );
      assert.ok(
        state.expressions?.some(
          (e) => "sourceAnimationId" in e && e.sourceAnimationId === "a" + i,
        ),
      );
    }
  } finally {
    await f.cleanup();
  }
});
test("missing position is distinct from missing object; separate X/Y channels preserve both source IDs", async () => {
  const f = await fixture();
  try {
    f.state.animations = f.state.animations.filter((a) => a.targetId !== "n3");
    const p = validateIntentPlan(f.project, prompt, plan(), 30, {
      state: f.state,
    });
    assert.equal(
      p.requirements[3].unresolvedReason,
      "BASE_POSITION_ANIMATION_MISSING",
    );
    assert.ok(
      p.requirements.slice(0, 3).every((r) => r.kind === "objectAnimation"),
    );
    f.state.animations.push({
      animationId: "x0",
      sceneId: "s0",
      targetId: "n0",
      effect: "property",
      parameters: { property: "x", from: 0, to: 10 },
      startFrame: 0,
      durationFrames: 15,
      easing: "linear",
      enabled: true,
    });
    const resolved = resolveBaseMotion(f.state, "s0", "n0");
    assert.equal(resolved.tracks.length, 2);
    assert.deepEqual(
      new Set(resolved.tracks.flatMap((t) => t.properties)),
      new Set(["x", "y"]),
    );
  } finally {
    await f.cleanup();
  }
});

test("production execution: four inertia requirements recovered from mock semantic output, real QA and persisted base preservation", async () => {
  const { registerProvider } = await import(
    "../src/harness/providers/index.js"
  );
  const { readMotion, changeMotion } = await import("../src/motion/store.js");
  const { executeMotion } = await import("../src/motion/service.js");
  const { inspectorRun } = await import("../src/harness/inspector.js");
  const f = await fixture();
  let calls = 0;
  f.state.animations = f.state.animations.map((a) => ({
    ...a,
    easing: a.animationId === "a0" ? "easeInQuad" : "linear",
  }));
  const stop = registerProvider("base-motion-mock", () => ({
    id: "base-motion-mock",
    mode: "mock",
    capabilities: () => ({
      structuredOutput: true,
      nativeToolCalling: false,
      cancellation: true,
      usage: false,
      nativeOutputTokenLimit: false,
    }),
    generate: async () => {
      calls++;
      return {
        output: plan(),
        usage: null,
        estimatedCost: null,
        latencyMs: 0,
        diagnostics: ["mock; not live-provider E2E"],
        toolCalls: [],
      };
    },
  }));
  try {
    let doc = await readMotion(f.project);
    doc = (
      await changeMotion(f.project.root, {
        expectedRevision: doc.revision,
        request: "seed synthetic position tracks",
        operations: [
          { type: "setProjectSettings", settings: f.state.settings },
          { type: "setBlocks", blocks: f.state.blocks },
          ...f.state.animations.map((animation) => ({
            type: "addAnimation" as const,
            animation,
          })),
        ],
      })
    ).document;
    const result = await executeMotion(f.project, {
      mode: "edit",
      request: prompt,
      activeSceneId: "s0",
      expectedRevision: doc.revision,
      settings: { provider: "base-motion-mock", model: "" },
    });
    assert.equal(
      result.reconciliation?.status,
      "SUCCESS",
      JSON.stringify(result),
    );
    assert.equal(calls, 1);
    const after = await readMotion(f.project);
    assert.deepEqual(after.state.animations, doc.state.animations);
    assert.equal(after.state.expressions?.length, 5);
    const view = await inspectorRun(f.project.root, result.id);
    assert.ok(
      JSON.stringify(view.targetResolution).includes("BASE_POSITION_RESOLVED"),
    );
  } finally {
    stop();
    await f.cleanup();
  }
});

test("existing inertia amplitude edits preserve IDs; duration edits retime attachment and sample updated base velocity", async () => {
  const f = await fixture();
  try {
    const p = validateIntentPlan(f.project, prompt, plan(), 30, {
      state: f.state,
    });
    let state = f.state;
    for (const task of compileTasks(f.project, p))
      state = applyOperations(
        state,
        compileRequirement(f.project, state, p, task).operations,
        f.project,
      );
    const ids = state.expressions!.map((e) => e.expressionId),
      before = structuredClone(state);
    const r = objectRequirement(
      "edit",
      "s0",
      "n0",
      "image",
      ["inertialOvershoot"],
      "image колебания вдвое слабее",
    );
    r.kind = "editAnimation";
    r.parameters.amplitudeFactor = 0.5;
    r.timing.relation = "unchanged";
    const ep: IntentPlan = {
      schemaVersion: "1.0.0",
      requirements: [r],
      coverage: [
        {
          sourceText: r.sourceText,
          requirementIds: ["edit"],
          classification: "executable",
          explanation: "edit",
        },
      ],
      assumptions: [],
    };
    const valid = validateIntentPlan(f.project, r.sourceText, ep, 30, {
      state,
    });
    state = applyOperations(
      state,
      compileRequirement(
        f.project,
        state,
        valid,
        compileTasks(f.project, valid)[0],
      ).operations,
      f.project,
    );
    assert.deepEqual(
      state.expressions!.map((e) => e.expressionId),
      ids,
    );
    assert.deepEqual(state.animations, before.animations);
    assert.equal(
      state.expressions!.find((e) => e.targetId === "n0")!.parameters.amplitude,
      before.expressions!.find((e) => e.targetId === "n0")!.parameters
        .amplitude * 0.5,
    );
    const a = state.animations.find((a) => a.animationId === "a1")!,
      velocity = resolveBaseMotion(state, "s0", "n1").tracks[0].incomingVelocity
        .y!;
    state = applyOperations(
      state,
      [{ type: "setDuration", animationId: "a1", durationFrames: 60 }],
      f.project,
    );
    assert.equal(
      state.expressions!.find(
        (e) => "sourceAnimationId" in e && e.sourceAnimationId === "a1",
      )!.startFrame,
      a.startFrame + 60,
    );
    assert.ok(
      Math.abs(
        resolveBaseMotion(state, "s0", "n1").tracks[0].incomingVelocity.y! -
          velocity / 2,
      ) < 0.01,
    );
  } finally {
    await f.cleanup();
  }
});

test("inertia Preview and decoded MP4 agree at a post-arrival frame", async () => {
  const { chromium } = await import("playwright");
  const { motionHtml } = await import("../src/motion/presentation.js");
  const { exportVideo } = await import("../src/motion/video.js");
  const { readMotion, changeMotion } = await import("../src/motion/store.js");
  const { createRequire } = await import("node:module");
  const { promisify } = await import("node:util");
  const { execFile } = await import("node:child_process");
  const path = await import("node:path");
  const f = await fixture();
  let browser;
  try {
    f.state.animations = f.state.animations.map((a) => ({
      ...a,
      easing: "linear",
    }));
    const p = validateIntentPlan(f.project, prompt, plan(), 30, {
      state: f.state,
    });
    let state = f.state;
    for (const task of compileTasks(f.project, p))
      state = applyOperations(
        state,
        compileRequirement(f.project, state, p, task).operations,
        f.project,
      );
    const before = await readMotion(f.project);
    const doc = (
      await changeMotion(f.project.root, {
        expectedRevision: before.revision,
        request: "synthetic inertia video fixture",
        operations: [
          { type: "setProjectSettings", settings: state.settings },
          { type: "setBlocks", blocks: state.blocks },
          ...state.animations.map((animation) => ({
            type: "addAnimation" as const,
            animation,
          })),
          ...state.expressions!.map((expression) => ({
            type: "setExpression" as const,
            expression,
          })),
        ],
      })
    ).document;
    browser = await chromium.launch();
    const page = await browser.newPage({
      viewport: { width: 200, height: 120 },
    });
    await page.setContent((await motionHtml(f.project, doc.state)).html);
    await page.evaluate(() => window.motionReady);
    await page.evaluate(() => window.motionFrame(35));
    const preview = await page.screenshot();
    const video = await exportVideo(f.project.root);
    const decoded = await promisify(execFile)(
      createRequire(import.meta.url)("ffmpeg-static"),
      [
        "-v",
        "error",
        "-i",
        path.join(f.project.root, "renders", video.file),
        "-vf",
        "select='eq(n,35)'",
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "png",
        "-",
      ],
      { encoding: "buffer", maxBuffer: 1000000 },
    );
    const error = await page.evaluate(
      async (srcs) => {
        const pixels = await Promise.all(
          srcs.map(async (src) => {
            const img = new Image();
            img.src = src;
            await img.decode();
            const c = document.createElement("canvas");
            c.width = img.width;
            c.height = img.height;
            const ctx = c.getContext("2d")!;
            ctx.drawImage(img, 0, 0);
            return ctx.getImageData(0, 0, c.width, c.height).data;
          }),
        );
        let sum = 0;
        for (let i = 0; i < pixels[0].length; i++)
          sum += Math.abs(pixels[0][i] - pixels[1][i]);
        return sum / pixels[0].length;
      },
      [preview, decoded.stdout].map(
        (b) => "data:image/png;base64," + b.toString("base64"),
      ),
    );
    assert.ok(error < 3, `Preview/MP4 mean pixel difference ${error}`);
  } finally {
    await browser?.close();
    await f.cleanup();
  }
});
