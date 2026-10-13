import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import {
  easingSchema,
  easingRegistry,
  evaluateEasing,
  easingCatalog,
  type Easing,
} from "../src/motion-library/easings/registry.js";
import { cubicBezier } from "../src/motion-library/easings/cubic-bezier.js";
import { curveData } from "../src/motion-library/easings/inspection.js";
import * as expressions from "../src/motion-library/expressions/functions.js";
import type { Expression } from "../src/motion-library/expressions/registry.js";
import {
  presetRegistry,
  instantiatePreset,
} from "../src/motion-library/presets/registry.js";
import { motionKnowledge } from "../src/motion-library/knowledge.js";
import { evaluateAnimation, evaluateMotion } from "../src/motion/engine.js";
import { applyOperations } from "../src/motion/operations.js";
import { readMotion, changeMotion } from "../src/motion/store.js";
import type { Animation } from "../src/motion/schema.js";
import { runAutonomous } from "../src/motion/autonomy.js";
import { motionHtml } from "../src/motion/presentation.js";
import { exportVideo } from "../src/motion/video.js";
import { identityFixture, node } from "./identity-fixture.js";
import { inventory, fingerprint } from "../src/files.js";
import { servePlatform } from "../src/platform-server.js";
const bezier: Easing = {
  type: "cubicBezier",
  parameters: { x1: 0.85, y1: 0, x2: 0.15, y2: 1 },
};
const base: Animation = {
  animationId: "base",
  sceneId: "s1",
  targetId: "qr1",
  effect: "property",
  parameters: { property: "y", from: 40, to: 0 },
  startFrame: 0,
  durationFrames: 12,
  easing: bezier,
  enabled: true,
};
const inertia: Expression = {
  expressionId: "inertia",
  sceneId: "s1",
  targetId: "qr1",
  type: "inertialOvershoot",
  property: "y",
  sourceAnimationId: "base",
  startFrame: 12,
  durationFrames: 12,
  enabled: true,
  parameters: {
    amplitude: 0.05,
    frequency: 3,
    decay: 4,
    velocityLookbackFrames: 2,
  },
};
const values = (state: Parameters<typeof evaluateMotion>[0], frame: number) =>
  evaluateMotion(state, frame).nodes[JSON.stringify(["s1", "qr1"])];

test("all easing registry entries serialize, remain finite and have exact boundaries", () => {
  assert.ok(easingRegistry.length >= 37);
  assert.equal(
    easingRegistry.length,
    new Set(easingRegistry.map((e) => e.id)).size,
  );
  for (const e of easingRegistry) {
    const data = easingSchema.parse({
      type: e.id,
      parameters: e.defaultParameters,
    });
    assert.equal(evaluateEasing(0, data), 0, e.id);
    assert.equal(evaluateEasing(1, data), 1, e.id);
    for (let i = 0; i <= 100; i++)
      assert.ok(Number.isFinite(evaluateEasing(i / 100, data)), e.id);
    assert.deepEqual(
      easingSchema.parse(JSON.parse(JSON.stringify(data))),
      data,
    );
  }
  assert.ok(
    easingCatalog().every((e) => e.parameterSchema && e.name && e.description),
  );
});
test("cubic Bezier inverts X; sharp middle, soft endpoints, flat-X degeneracy and overshoot", () => {
  const x1 = 0.85,
    x2 = 0.15,
    y1 = 0,
    y2 = 1,
    u = 0.23;
  const x = 3 * (1 - u) ** 2 * u * x1 + 3 * (1 - u) * u * u * x2 + u ** 3,
    y = 3 * (1 - u) * u * u + u ** 3;
  const fn = cubicBezier(x1, y1, x2, y2);
  assert.ok(Math.abs(fn(x) - y) < 1e-8);
  assert.ok(Math.abs(fn(x) - x) > 0.01);
  assert.ok(fn(0.1) < 0.01);
  assert.ok(fn(0.55) - fn(0.45) > 0.4);
  assert.ok(1 - fn(0.99) < 0.001);
  for (const pair of [
    [0, 0],
    [1, 1],
    [1, 0],
  ])
    for (let i = 0; i <= 100; i++)
      assert.ok(Number.isFinite(cubicBezier(pair[0], 0, pair[1], 1)(i / 100)));
  assert.ok(
    Array.from({ length: 101 }, (_, i) =>
      cubicBezier(0.4, 3, 0.6, 3)(i / 100),
    ).some((v) => v > 1),
  );
  assert.throws(() => cubicBezier(-0.1, 0, 0.5, 1));
});
test("piecewise Hermite has continuous position and shared derivatives; malformed curves/code reject", () => {
  const e: Easing = easingSchema.parse({
    type: "piecewise",
    parameters: {
      interpolation: "hermite",
      points: [
        { t: 0, value: 0, slope: 0 },
        { t: 0.3, value: 0.03 },
        { t: 0.65, value: 0.9 },
        { t: 1, value: 1, slope: 0 },
      ],
    },
  });
  const h = 1e-6;
  for (const t of [0.3, 0.65]) {
    const center = evaluateEasing(t, e),
      left = (center - evaluateEasing(t - h, e)) / h,
      right = (evaluateEasing(t + h, e) - center) / h;
    assert.ok(Math.abs(left - right) < 1e-3);
  }
  assert.throws(() =>
    easingSchema.parse({
      type: "piecewise",
      parameters: {
        interpolation: "linear",
        points: [
          { t: 0, value: 0 },
          { t: 0, value: 0.2 },
          { t: 1, value: 1 },
        ],
      },
    }),
  );
  assert.throws(() =>
    easingSchema.parse({ type: "javascript", code: "process.exit()" }),
  );
  assert.throws(() =>
    easingSchema.parse({
      type: "cubicBezier",
      parameters: { x1: 2, y1: 0, x2: 0, y2: 1 },
    }),
  );
});
test("finite spring covers under/critical/overdamping, back overshoots and endpoint has no snap", () => {
  for (const damping of [0.01, 2 * Math.sqrt(180), 100]) {
    const e: Easing = {
      type: "spring",
      parameters: { stiffness: 180, damping, mass: 1 },
    };
    assert.equal(evaluateEasing(1, e), 1);
    assert.ok(Math.abs(evaluateEasing(1 - 1e-5, e) - 1) < 1e-9);
    for (let i = 0; i <= 100; i++)
      assert.ok(Number.isFinite(evaluateEasing(i / 100, e)));
  }
  assert.ok(
    evaluateEasing(0.7, { type: "back", parameters: { overshoot: 4 } }) > 1,
  );
  for (const name of ["easeOutExpo", "easeOutElastic"])
    assert.ok(Math.abs(evaluateEasing(1 - 1e-6, name) - 1) < 1e-5);
});
test("seeded expressions, time/velocity/key helpers and loop are deterministic", () => {
  const sequence = Array.from({ length: 100 }, (_, i) =>
    expressions.wiggle(i / 30, 10, 3, 123),
  );
  for (const i of [75, 0, 99, 12, 75])
    assert.equal(expressions.wiggle(i / 30, 10, 3, 123), sequence[i]);
  assert.notEqual(
    expressions.wiggle(0.5, 10, 3, 123),
    expressions.wiggle(0.5, 10, 3, 124),
  );
  assert.equal(
    expressions.valueAtTime((t) => t * 4, 3),
    12,
  );
  assert.ok(Math.abs(expressions.velocityAtTime((t) => t * 4, 3) - 4) < 1e-8);
  assert.equal(expressions.nearestKey([0, 1, 2], 1.3), 1);
  assert.equal(expressions.nearestKey([], 1), null);
  assert.equal(expressions.loop(1.25, 1, "pingPong"), 0.75);
  assert.equal(expressions.loop(1.25, 1, "cycle"), 0.25);
  const t = 0.1;
  assert.equal(
    expressions.inertialOvershoot(t, 40, 0.05, 3, 4),
    40 * 0.05 * Math.sin(6 * Math.PI * t) * Math.exp(-4 * t),
  );
});
test("base easing + velocity-based inertia + additive wiggle; deterministic seek and finite property bounds", async () => {
  const f = await identityFixture();
  try {
    const state = applyOperations(
      f.state,
      [
        { type: "addAnimation", animation: base },
        { type: "setExpression", expression: inertia },
        {
          type: "setExpression",
          expression: {
            expressionId: "wiggle",
            sceneId: "s1",
            targetId: "qr1",
            type: "wiggle",
            property: "y",
            startFrame: 12,
            durationFrames: 12,
            enabled: true,
            parameters: { amplitude: 2, frequency: 2, seed: 10 },
          },
        },
      ],
      f.project,
    );
    for (const frame of [0, 6, 12, 15, 19, 24, 15])
      assert.deepEqual(
        evaluateMotion(state, frame),
        evaluateMotion(structuredClone(state), frame),
      );
    assert.equal(values(state, 12).y, 0);
    assert.notEqual(values(state, 13).y, 0);
    assert.equal(values(state, 24).y, 0);
    assert.ok(
      Math.abs(values(state, 6).y! - evaluateAnimation(base, 6).y!) < 1e-6,
    );
  } finally {
    await f.cleanup();
  }
});
test("relative expression edits halve CURRENT amplitude twice and preserve easing, IDs, decay, history and source", async () => {
  const f = await identityFixture();
  try {
    const hash = fingerprint(await inventory(f.project.sourceRoot));
    let doc = (
      await changeMotion(f.project.root, {
        expectedRevision: "initial",
        request: "initial",
        operations: [
          { type: "addAnimation", animation: base },
          { type: "setExpression", expression: inertia },
        ],
      })
    ).document;
    const original = structuredClone(doc.state);
    for (const amplitude of [0.025, 0.0125]) {
      doc = (
        await changeMotion(f.project.root, {
          expectedRevision: doc.revision,
          request: "half",
          operations: [
            {
              type: "scaleExpressionParameter",
              expressionId: "inertia",
              parameter: "amplitude",
              factor: 0.5,
            },
          ],
        })
      ).document;
      assert.equal(doc.state.expressions![0].parameters.amplitude, amplitude);
    }
    assert.deepEqual(doc.state.animations, original.animations);
    assert.deepEqual(doc.state.expressions![0], {
      ...original.expressions![0],
      parameters: { ...original.expressions![0].parameters, amplitude: 0.0125 },
    });
    assert.deepEqual((await readMotion(f.project)).state, doc.state);
    doc = (
      await changeMotion(f.project.root, {
        expectedRevision: doc.revision,
        request: "undo",
        action: "undo",
      })
    ).document;
    assert.equal(doc.state.expressions![0].parameters.amplitude, 0.025);
    assert.equal(fingerprint(await inventory(f.project.sourceRoot)), hash);
  } finally {
    await f.cleanup();
  }
});
test("preset expansion produces editable ordinary tracks; no live default reset", async () => {
  const f = await identityFixture();
  try {
    for (const p of presetRegistry) {
      const data = instantiatePreset(p.id, p.id, "s1", "qr1", 0, 12);
      assert.ok(data.animations.length + data.expressions.length > 0);
      const initial = {
        ...f.state,
        settings: { ...f.state.settings, durationFrames: 120 },
        blocks: [{ ...f.state.blocks[0], durationFrames: 120 }],
      };
      const state = applyOperations(
        initial,
        [
          {
            type: "applyMotionPreset",
            presetId: p.id,
            instanceId: p.id,
            sceneId: "s1",
            targetId: "qr1",
            startFrame: 0,
          },
        ],
        f.project,
      );
      for (const frame of [0, 10, 30, 60]) evaluateMotion(state, frame);
    }
  } finally {
    await f.cleanup();
  }
});
test("knowledge retrieves bounded relevant local skills, lets user override guidance, and custom easing AI operation updates one field", async () => {
  const f = await identityFixture();
  try {
    const knowledge = await motionKnowledge(
      "RED COLLAR: сильное преувеличенное движение",
      true,
    );
    assert.equal(knowledge.skills.length, 2);
    assert.ok(knowledge.skills.some((s) => s.id === "kinetic-typography"));
    assert.ok(
      knowledge.priority.indexOf("latest user instruction") <
        knowledge.priority.indexOf("motion skills"),
    );
    assert.ok(knowledge.customEasings.some((e) => e.id === "piecewise"));
    const state = applyOperations(
      f.state,
      [{ type: "addAnimation", animation: base }],
      f.project,
    );
    const custom = {
      type: "cubicBezier",
      parameters: { x1: 0.95, y1: 0, x2: 0.05, y2: 1 },
    };
    const generated = await runAutonomous(
      f.project,
      state,
      { motionKnowledge: knowledge },
      "Разгон резче",
      async () => ({
        status: "ready",
        summary: "Более резкий разгон",
        assumptions: [],
        warnings: [],
        operations: [
          { type: "setEasing", animationId: "base", easing: custom },
        ],
      }),
    );
    assert.deepEqual(generated.next.animations[0], { ...base, easing: custom });
  } finally {
    await f.cleanup();
  }
});
test("legacy string easing stays compatible; strong custom overshoot remains finite and scale/opacity valid", async () => {
  const f = await identityFixture();
  try {
    assert.equal(
      evaluateAnimation({ ...base, easing: "easeOutCubic" }, 6).y,
      5,
    );
    for (const property of ["scaleX", "scaleY", "opacity"] as const) {
      const a: Animation = {
        ...base,
        parameters: { property, from: property === "opacity" ? 0 : 0.1, to: 1 },
        easing: {
          type: "cubicBezier",
          parameters: { x1: 0.4, y1: 10, x2: 0.6, y2: -10 },
        },
      };
      const state = applyOperations(
        f.state,
        [{ type: "addAnimation", animation: a }],
        f.project,
      );
      for (let frame = 0; frame <= 12; frame++) {
        const v = values(state, frame)[property]!;
        assert.ok(Number.isFinite(v));
        if (property === "opacity") assert.ok(v >= 0 && v <= 1);
        else assert.ok(v > 0);
      }
    }
    assert.ok(
      curveData({ type: "back", parameters: { overshoot: 3 } }).max > 1,
    );
  } finally {
    await f.cleanup();
  }
});
test("same expressions animate TEXT, image-filled RECTANGLE, VECTOR and GROUP in Chromium", async () => {
  const f = await identityFixture(3, (scenes) => {
    const text = node("text", "RED COLLAR", 5, 5, 100, 20);
    text.type = "TEXT";
    text.text = {
      characters: "RED COLLAR",
      fontSize: 12,
      fontName: { family: "Arial", style: "Regular" },
    };
    const image = node("image", "Image", 10, 40);
    image.properties.fills = [
      { type: "IMAGE", assetId: "qr-svg", scaleMode: "FIT" },
    ];
    const group = node("group", "Group", 60, 40, 20, 20, [
      node("child", "Child", 60, 40),
    ]);
    group.type = "GROUP";
    scenes[1].children.push(text, image, group);
  });
  const browser = await chromium.launch();
  try {
    const operations = ["qr1", "text", "image", "group"].map((targetId, i) => ({
      type: "setExpression",
      expression: {
        expressionId: `e${i}`,
        sceneId: "s1",
        targetId,
        type: "wiggle",
        property: "x",
        startFrame: 12,
        durationFrames: 10,
        enabled: true,
        parameters: { amplitude: 3, frequency: 3, seed: 4 },
      },
    }));
    const state = applyOperations(f.state, operations, f.project),
      page = await browser.newPage({ viewport: { width: 200, height: 120 } });
    await page.setContent((await motionHtml(f.project, state)).html);
    await page.evaluate(() => window.motionReady);
    await page.evaluate(() => window.motionFrame(17));
    const transforms = await page
      .locator('[data-motion-scene="s1"] [data-motion-target]')
      .evaluateAll((els) =>
        Object.fromEntries(
          els.map((el) => [
            el.getAttribute("data-motion-target"),
            el.getAttribute("transform"),
          ]),
        ),
      );
    const offsets = ["qr1", "text", "image", "group"].map((id) =>
      Number(transforms[id]!.match(/translate\(([^ ]+)/)![1]),
    );
    assert.ok(offsets.every((v) => v !== 0 && v === offsets[0]));
  } finally {
    await browser.close();
    await f.cleanup();
  }
});
test("easing inspector uses same evaluator and preview/MP4 match custom easing plus expressions", async () => {
  const f = await identityFixture(),
    browser = await chromium.launch();
  let server: Awaited<ReturnType<typeof servePlatform>> | undefined;
  try {
    const animation = { ...base, startFrame: 12, durationFrames: 6 };
    const expression = { ...inertia, startFrame: 18, durationFrames: 12 };
    const doc = (
      await changeMotion(f.project.root, {
        expectedRevision: "initial",
        request: "custom fixture",
        operations: [
          { type: "setProjectSettings", settings: f.state.settings },
          { type: "setBlocks", blocks: f.state.blocks },
          { type: "addAnimation", animation },
          { type: "setExpression", expression },
        ],
      })
    ).document;
    const page = await browser.newPage({
      viewport: { width: 200, height: 120 },
    });
    await page.setContent((await motionHtml(f.project, doc.state)).html);
    await page.evaluate(() => window.motionReady);
    await page.evaluate(() => window.motionFrame(19));
    const preview = await page.screenshot();
    const result = await exportVideo(f.project.root);
    assert.equal(result.frames, 36);
    const ffmpeg = createRequire(import.meta.url)("ffmpeg-static") as string;
    const decoded = await promisify(execFile)(
      ffmpeg,
      [
        "-v",
        "error",
        "-i",
        path.join(f.project.root, "renders", result.file),
        "-vf",
        "select='eq(n,19)'",
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
    const difference = await page.evaluate(
      async (sources) => {
        const pixels = await Promise.all(
          sources.map(async (src) => {
            const i = new Image();
            i.src = src;
            await i.decode();
            const c = document.createElement("canvas");
            c.width = i.width;
            c.height = i.height;
            const ctx = c.getContext("2d")!;
            ctx.drawImage(i, 0, 0);
            return ctx.getImageData(0, 0, i.width, i.height).data;
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
    assert.ok(difference < 3);
    server = await servePlatform(path.dirname(f.project.root), 0);
    const ui = await browser.newPage();
    await ui.goto(
      `http://127.0.0.1:${(server.address() as { port: number }).port}/#project/${f.project.config.projectId}`,
    );
    await ui.locator("[data-scene-button]").nth(1).click();
    await ui.locator('[data-target="qr1"]').click();
    await ui.locator("#m-open-settings").click();
    await ui.locator(".curve-inspector summary").click();
    assert.equal(
      await ui.locator("#m-curve .curve-line").getAttribute("d"),
      curveData(bezier).path,
    );
  } finally {
    await browser.close();
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    await f.cleanup();
  }
});

test("provider output schema requires every object field including empty parameter objects", async () => {
  const { outputSchema } = await import("../src/motion/provider.js");
  let objects = 0;
  function inspect(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(inspect);
      return;
    }
    const schema = value as Record<string, unknown>;
    if (schema.type === "object") {
      objects++;
      assert.deepEqual(
        schema.required,
        Object.keys(schema.properties as object),
      );
      assert.equal(schema.additionalProperties, false);
    }
    Object.values(schema).forEach(inspect);
  }
  inspect(outputSchema);
  assert.ok(objects > 10);
});
