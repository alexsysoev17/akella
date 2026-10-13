import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify, isDeepStrictEqual } from "node:util";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import { identityFixture, node } from "./identity-fixture.js";
import { objectRequirement } from "./intent-fixture.js";
import {
  objectNameMatch,
  objectMentionRanges,
  equivalentObjectName,
} from "../src/motion/object-aliases.js";
import {
  resolveObjectReference,
  resolveExistingAnimation,
} from "../src/motion/object-resolution.js";
import { logicalId } from "../src/motion/registry.js";
import { type IntentPlan } from "../src/motion/intent/schema.js";
import { validateIntentPlan } from "../src/motion/intent/planner.js";
import {
  compileTasks,
  compileRequirement,
} from "../src/motion/intent/compiler.js";
import { applyOperations } from "../src/motion/operations.js";
import { agentContext } from "../src/harness/context.js";
import { harnessConfigSchema } from "../src/harness/config.js";
import { executeMotion } from "../src/motion/service.js";
import { registerProvider } from "../src/harness/providers/index.js";
import { readMotion, changeMotion } from "../src/motion/store.js";
import { inspectorRun } from "../src/harness/inspector.js";
import { motionHtml } from "../src/motion/presentation.js";
import { exportVideo } from "../src/motion/video.js";
import type { Animation } from "../src/motion/schema.js";
const originalPrompt =
  "ленту 2 заанимируй от конца к началу тогда по trim paths просто я сейчас смотрю она анимиурется с противоположного конца который мне нужен";
async function fixture() {
  const f = await identityFixture(3, (scenes) => {
    scenes.forEach((s, i) => {
      s.name = String(i + 1);
      s.parentId = "page";
    });
    scenes[0].children = [];
    scenes[1].children = [
      node("qr", "Куар", 40, 20),
      node("logo", "Логотип", 80, 20),
    ];
    scenes[2].children = ["Лента 1", "Лента 2", "Лента 20"].map((name, i) => {
      const n = node(
        "ribbon" + (i === 2 ? 20 : i + 1),
        name,
        10,
        20 + i * 30,
        150,
        10,
      );
      n.type = "VECTOR";
      n.properties = {
        ...n.properties,
        fills: [],
        strokeWeight: 4,
        strokeAlign: "CENTER",
        strokes: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }],
        vectorPaths: [{ data: "M0 0 L150 0", windingRule: "NONZERO" }],
      };
      return n;
    });
  });
  const animations: Animation[] = [1, 2].map((i) => ({
    animationId: "trim" + i,
    sceneId: "s2",
    targetId: "ribbon" + i,
    effect: "trimPath",
    parameters: { from: 0, to: 1, direction: "forward" },
    startFrame: 24 + (i - 1) * 4,
    durationFrames: 4,
    easing: "linear",
    enabled: true,
  }));
  const move: Animation = {
    animationId: "qr-move",
    sceneId: "s1",
    targetId: "qr",
    effect: "slideUp",
    parameters: { distance: 20, mode: "in" },
    startFrame: 12,
    durationFrames: 4,
    easing: "linear",
    enabled: true,
  };
  f.state.animations = [...animations, move];
  f.state.expressions = [
    {
      expressionId: "qr-inertia",
      sceneId: "s1",
      targetId: "qr",
      type: "inertialOvershoot",
      property: "y",
      sourceAnimationId: move.animationId,
      startFrame: 16,
      durationFrames: 6,
      enabled: true,
      parameters: {
        mode: "ae",
        amplitude: 0.05,
        frequency: 2,
        decay: 5,
        velocityLookbackFrames: 3,
      },
    },
  ];
  f.state.timingDependencies = [
    {
      dependencyId: "ribbon-sequence",
      animationId: "trim2",
      anchorAnimationId: "trim1",
      relation: "after",
      offsetFrames: 0,
    },
  ];
  return f;
}
function planFor(prompt = originalPrompt, unsupported = true): IntentPlan {
  const r = objectRequirement(
    "edit-ribbon",
    "s2",
    "ribbon2",
    "Лента 2",
    ["trimPath"],
    prompt,
  );
  r.kind = unsupported ? "unsupported" : "editAnimation";
  if (unsupported) {
    r.target = { sourceNodeId: null, logicalObjectId: null, name: null };
    r.unresolvedReason = "Object not found in provided context";
  }
  r.timing.relation = "unchanged";
  r.parameters.direction = "reverse";
  return {
    schemaVersion: "1.0.0",
    requirements: [r],
    coverage: [
      {
        sourceText: prompt,
        requirementIds: [r.requirementId],
        classification: unsupported ? "unsupported" : "executable",
        explanation: "redacted historical response shape on synthetic IDs",
      },
    ],
    assumptions: [],
  };
}
async function seed(f: Awaited<ReturnType<typeof fixture>>) {
  const d = await readMotion(f.project);
  return (
    await changeMotion(f.project.root, {
      expectedRevision: d.revision,
      request: "synthetic motion fixture",
      operations: [
        { type: "setProjectSettings", settings: f.state.settings },
        { type: "setBlocks", blocks: f.state.blocks },
        ...f.state.animations.map((animation) => ({
          type: "addAnimation",
          animation,
        })),
        ...(f.state.expressions ?? []).map((expression) => ({
          type: "setExpression",
          expression,
        })),
        ...(f.state.timingDependencies ?? []).map((dependency) => ({
          type: "setTimingDependency",
          dependency,
        })),
      ],
    })
  ).document;
}
test("Russian reference forms, productive noun/adjective inflections and ordinals resolve canonical IDs, never 1/2/20 substring or logical identity changes", async () => {
  const f = await fixture();
  try {
    for (const referenceText of [
      "Ленту 2 поменяй",
      "Ленте 2 добавь эффект",
      "Лентой 2",
      "У ленты 2",
      "Вторая лента",
      "У второй ленты измени направление",
      "для второй ленты",
      "вторую ленту",
      "ЛЕНТУ 2",
      "ленту\u00a0\u20092",
      "  ленту   2!",
    ]) {
      const r = resolveObjectReference(f.project, f.state, { referenceText });
      assert.equal(r.status, "RESOLVED", referenceText);
      assert.equal(r.target!.sourceNodeId, "ribbon2");
      assert.equal(r.target!.logicalObjectId, logicalId("Лента 2"));
    }
    assert.ok(equivalentObjectName("Красная кнопка 2", "красную кнопку 2"));
    assert.ok(equivalentObjectName("Прямоугольник 1", "прямоугольником 1"));
    assert.ok(equivalentObjectName("Фон", "фону"));
    assert.deepEqual(objectMentionRanges("", "Ленту 2"), []);
    assert.deepEqual(objectMentionRanges("—", "Ленту 2"), []);
    assert.ok(!objectNameMatch("Лента 2", "ленту 20"));
    assert.ok(!objectNameMatch("Текст 1", "текст 2"));
    for (const name of ["логотипу", "логотипом", "лого"])
      assert.equal(
        resolveObjectReference(f.project, f.state, { referenceText: name })
          .target!.sourceNodeId,
        "logo",
      );
    for (const name of ["QR", "QR-код", "куар-код"])
      assert.equal(
        resolveObjectReference(f.project, f.state, { referenceText: name })
          .target!.sourceNodeId,
        "qr",
      );
  } finally {
    await f.cleanup();
  }
});
test("morphological retrieval selects actual Scene3, not numeric root Frame2; compact index exposes existing IDs", async () => {
  const f = await fixture();
  try {
    const c = (
      await agentContext(
        f.project,
        f.state,
        { request: originalPrompt, activeSceneId: "s0" },
        [],
        harnessConfigSchema.parse({}),
      )
    ).value;
    assert.deepEqual(
      c.scenes.map((s) => s.sceneId),
      ["s2"],
    );
    const o = c.objectIndex.find((o) => o.sourceNodeId === "ribbon2")!;
    assert.deepEqual(o.existingAnimations, [
      {
        animationId: "trim2",
        effect: "trimPath",
        channels: ["trim"],
        startFrame: 28,
        endFrame: 32,
      },
    ]);
    assert.ok(c.motion.animations.some((a) => a.animationId === "trim2"));
  } finally {
    await f.cleanup();
  }
});
test("equivalent candidates remain ambiguous; explicit IDs, scene or actual existing effect can disambiguate without guessing", async () => {
  const f = await fixture();
  try {
    const roots = f.project.inspection.document.scenes;
    const other = node("other", "Ленты 2");
    other.parentId = "root0";
    roots[0].children.push(other);
    assert.equal(
      resolveObjectReference(f.project, f.state, { referenceText: "ленту 2" })
        .status,
      "AMBIGUOUS_TARGET",
    );
    assert.equal(
      resolveObjectReference(f.project, f.state, {
        referenceText: "ленту 2",
        sceneId: "s2",
      }).target!.sourceNodeId,
      "ribbon2",
    );
    assert.equal(
      resolveObjectReference(f.project, f.state, {
        referenceText: "ленту 2",
        activeSceneId: "s0",
        techniques: ["trimPath"],
        preferExisting: true,
      }).target!.sourceNodeId,
      "ribbon2",
    );
    assert.equal(
      resolveObjectReference(f.project, f.state, {
        referenceText: "ленту 2",
        sourceNodeId: "other",
        sceneId: "s0",
      }).target!.sourceNodeId,
      "other",
    );
    const duplicate = node("duplicate", "QR");
    duplicate.parentId = "root1";
    roots[1].children.push(duplicate);
    assert.equal(
      resolveObjectReference(f.project, f.state, { referenceText: "QR" })
        .status,
      "AMBIGUOUS_TARGET",
    );
  } finally {
    await f.cleanup();
  }
});
test("post-plan null unsupported target recovers from authoritative state, edits reverse only and blocks missing/ambiguous tracks", async () => {
  const f = await fixture();
  try {
    const events: unknown[] = [];
    const plan = validateIntentPlan(f.project, originalPrompt, planFor(), 12, {
      state: f.state,
      onResolution: (v) => events.push(v),
    });
    assert.equal(plan.requirements[0].kind, "editAnimation");
    assert.ok(
      JSON.stringify(events).includes("TARGET_RECOVERED_FROM_PROJECT_STATE"),
    );
    const ops = compileRequirement(
      f.project,
      f.state,
      plan,
      compileTasks(f.project, plan)[0],
    ).operations;
    assert.equal(ops.length, 1);
    const next = applyOperations(f.state, ops, f.project),
      expected = structuredClone(f.state);
    const a = expected.animations.find((a) => a.animationId === "trim2")!;
    if (a.effect === "trimPath") a.parameters.direction = "reverse";
    assert.deepEqual(next, expected);
    const empty = {
      ...f.state,
      animations: f.state.animations.filter((a) => a.targetId !== "ribbon2"),
    };
    const blocked = validateIntentPlan(
      f.project,
      originalPrompt,
      planFor(),
      12,
      { state: empty },
    );
    assert.equal(
      blocked.requirements[0].unresolvedReason,
      "EXISTING_ANIMATION_NOT_FOUND",
    );
    const doubled = {
      ...f.state,
      animations: [
        ...f.state.animations,
        { ...f.state.animations[1], animationId: "other-trim" },
      ],
    };
    assert.equal(
      resolveExistingAnimation(
        doubled,
        resolveObjectReference(f.project, f.state, { referenceText: "ленту 2" })
          .target!,
        ["trimPath"],
      ).status,
      "AMBIGUOUS_ANIMATION",
    );
  } finally {
    await f.cleanup();
  }
});
test("existing parameter edits preserve unrelated tracks and update genuine temporal dependencies", async () => {
  const f = await fixture();
  try {
    const speed = planFor("Ленту 1 сделай быстрее", false);
    Object.assign(speed.requirements[0].target, {
      sourceNodeId: "ribbon1",
      name: "Лента 1",
    });
    speed.requirements[0].parameters.direction = null;
    speed.requirements[0].parameters.durationFactor = 0.5;
    const s = validateIntentPlan(
      f.project,
      speed.requirements[0].sourceText,
      speed,
      12,
      { state: f.state },
    );
    const next = applyOperations(
      f.state,
      compileRequirement(f.project, f.state, s, compileTasks(f.project, s)[0])
        .operations,
      f.project,
    );
    assert.equal(next.animations[0].durationFrames, 2);
    assert.equal(next.animations[1].startFrame, 26);
    assert.equal(next.animations[1].animationId, "trim2");
    assert.deepEqual(next.expressions, f.state.expressions);
    const prompt = "У QR сделай инерцию в два раза слабее",
      r = objectRequirement(
        "qr-edit",
        "s1",
        "qr",
        "QR",
        ["inertialOvershoot"],
        prompt,
      );
    r.kind = "editAnimation";
    r.parameters.amplitudeFactor = 0.5;
    r.timing.relation = "unchanged";
    const p: IntentPlan = {
      schemaVersion: "1.0.0",
      requirements: [r],
      coverage: [
        {
          sourceText: prompt,
          requirementIds: [r.requirementId],
          classification: "executable",
          explanation: "synthetic",
        },
      ],
      assumptions: [],
    };
    const validated = validateIntentPlan(f.project, prompt, p, 12, {
      state: f.state,
    });
    const edited = applyOperations(
      f.state,
      compileRequirement(
        f.project,
        f.state,
        validated,
        compileTasks(f.project, validated)[0],
      ).operations,
      f.project,
    );
    assert.deepEqual(edited.animations, f.state.animations);
    assert.equal(edited.expressions![0].parameters.amplitude, 0.025);
  } finally {
    await f.cleanup();
  }
});
test("complete natural edit workflow: one mock semantic call, post-plan recovery, selective real QA, persisted direction and Inspector provenance", async () => {
  const f = await fixture();
  let calls = 0;
  const stop = registerProvider("reference-mock", () => ({
    id: "reference-mock",
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
        output: planFor(),
        usage: null,
        estimatedCost: null,
        latencyMs: 1,
        diagnostics: ["mock provider, not live E2E"],
        toolCalls: [],
      };
    },
  }));
  try {
    const before = await seed(f);
    const source = await readFile(
      path.join(f.project.sourceRoot, "scene.json"),
    );
    const result = await executeMotion(f.project, {
      mode: "edit",
      request: originalPrompt,
      activeSceneId: "s0",
      settings: { provider: "reference-mock", model: "" },
      expectedRevision: before.revision,
    });
    assert.equal(result.reconciliation?.status, "SUCCESS");
    assert.equal(calls, 1);
    const doc = await readMotion(f.project),
      expected = structuredClone(before.state);
    const track = expected.animations.find((a) => a.animationId === "trim2")!;
    if (track.effect === "trimPath") track.parameters.direction = "reverse";
    assert.deepEqual(doc.state, expected);
    assert.deepEqual(
      await readFile(path.join(f.project.sourceRoot, "scene.json")),
      source,
    );
    const view = await inspectorRun(f.project.root, result.id);
    assert.ok(
      JSON.stringify(view.targetResolution).includes(
        "TARGET_RECOVERED_FROM_PROJECT_STATE",
      ),
    );
    assert.ok(JSON.stringify(view.stateChanges).includes("reverse"));
    assert.ok(
      (view.run as { metrics: { renderedQAFrames: number } }).metrics
        .renderedQAFrames < 40,
    );
  } finally {
    stop();
    await f.cleanup();
  }
});
test("reversed path direction is identical in actual Preview and decoded MP4; progress remains hidden to visible", async () => {
  const f = await fixture();
  let browser;
  try {
    await seed(f);
    const d = await readMotion(f.project),
      a = structuredClone(d.state.animations[1]);
    if (a.effect === "trimPath") a.parameters.direction = "reverse";
    const doc = (
      await changeMotion(f.project.root, {
        expectedRevision: d.revision,
        request: "synthetic direction edit",
        operations: [
          { type: "updateAnimation", animationId: a.animationId, animation: a },
        ],
      })
    ).document;
    browser = await chromium.launch();
    const page = await browser.newPage({
      viewport: { width: 200, height: 120 },
    });
    await page.setContent((await motionHtml(f.project, doc.state)).html);
    await page.evaluate(() => window.motionReady);
    await page.evaluate(() => window.motionFrame(29));
    const attrs = await page
      .locator("[data-motion-reveal]")
      .evaluateAll((nodes) =>
        nodes.map((n) => ({
          direction: n.getAttribute("data-motion-reveal-direction"),
          progress: Number(n.getAttribute("data-motion-reveal-progress")),
        })),
      );
    assert.ok(
      attrs.some(
        (a) => a.direction === "reverse" && a.progress > 0 && a.progress < 1,
      ),
    );
    const preview = await page.screenshot();
    const video = await exportVideo(f.project.root);
    const ffmpeg = createRequire(import.meta.url)("ffmpeg-static") as string;
    const decoded = await promisify(execFile)(
      ffmpeg,
      [
        "-v",
        "error",
        "-i",
        path.join(f.project.root, "renders", video.file),
        "-vf",
        "select='eq(n,29)'",
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
        let total = 0;
        for (let i = 0; i < pixels[0].length; i++)
          total += Math.abs(pixels[0][i] - pixels[1][i]);
        return total / pixels[0].length;
      },
      [preview, decoded.stdout].map(
        (b) => "data:image/png;base64," + b.toString("base64"),
      ),
    );
    assert.ok(error < 3, `decoded MP4 difference ${error}`);
  } finally {
    await browser?.close();
    await f.cleanup();
  }
});

test("existing position/scale/slide parameter edits reuse original track IDs and checked operations", async () => {
  const f = await fixture();
  try {
    const tracks: Animation[] = [
      {
        animationId: "logo-position",
        sceneId: "s1",
        targetId: "logo",
        startFrame: 12,
        durationFrames: 4,
        easing: "linear",
        enabled: true,
        effect: "moveTo",
        parameters: { fromX: 0, toX: 10, fromY: 0, toY: 0 },
      },
      {
        animationId: "qr-scale",
        sceneId: "s1",
        targetId: "qr",
        startFrame: 12,
        durationFrames: 4,
        easing: "linear",
        enabled: true,
        effect: "scaleIn",
        parameters: { from: 1, to: 1.1 },
      },
    ];
    const state = {
      ...f.state,
      animations: [...f.state.animations, ...tracks],
    };
    for (const [target, name, tech, params] of [
      ["logo", "Логотипу", "moveTo", { x: -20 }],
      ["qr", "QR", "scaleIn", { scaleTo: 1.2 }],
      ["qr", "Куар", "slideUp", { distance: 30 }],
    ] as const) {
      const text = name + " измени анимацию";
      const r = objectRequirement(
        "local-edit",
        "s1",
        target,
        name,
        [tech],
        text,
      );
      r.kind = "editAnimation";
      r.timing.relation = "unchanged";
      Object.assign(r.parameters, params);
      const plan: IntentPlan = {
        schemaVersion: "1.0.0",
        requirements: [r],
        coverage: [
          {
            sourceText: text,
            requirementIds: [r.requirementId],
            classification: "executable",
            explanation: "synthetic",
          },
        ],
        assumptions: [],
      };
      const validated = validateIntentPlan(f.project, text, plan, 12, {
        state,
      });
      const ops = compileRequirement(
        f.project,
        state,
        validated,
        compileTasks(f.project, validated)[0],
      ).operations;
      assert.equal(ops.filter((op) => op.type === "updateAnimation").length, 1);
      assert.equal(ops[0].type, "updateAnimation");
      const next = applyOperations(state, ops, f.project);
      const changed = next.animations.filter(
        (a) =>
          !isDeepStrictEqual(
            a,
            state.animations.find((old) => old.animationId === a.animationId),
          ),
      );
      assert.equal(changed.length, 1);
      assert.equal(
        changed[0].animationId,
        state.animations.find(
          (a) => a.targetId === target && a.effect === tech,
        )!.animationId,
      );
    }
  } finally {
    await f.cleanup();
  }
});
