import test from "node:test";
import { writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { readMotion } from "../src/motion/store.js";
import { exportVideo } from "../src/motion/video.js";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { identityFixture, node } from "./identity-fixture.js";
import { motionHtml } from "../src/motion/presentation.js";
import { textSchedule } from "../src/motion/text-animation.js";
import { applyOperations } from "../src/motion/operations.js";
import type { Animation } from "../src/motion/schema.js";
const text = "Абонемент\nна любую еду\nи напитки";
const settings = {
  segmentation: "line" as const,
  timing: "staggered" as const,
  staggerFrames: 5,
  reverse: false,
  origin: "outsideViewport" as const,
};
test("text scheduling uses one bounded timeline interval and does not silently overflow", () => {
  assert.deepEqual(textSchedule(40, 3, settings), { step: 5, duration: 30 });
  assert.deepEqual(textSchedule(30, 3, { ...settings, timing: "sequential" }), {
    step: 10,
    duration: 10,
  });
  assert.throws(
    () => textSchedule(3, 3, settings),
    /TEXT_STAGGER_EXCEEDS_DURATION/,
  );
});
test("shaped multiline snapshot, fade/offscreen, nonsequential seek and final source pixels", async () => {
  const fixture = await identityFixture(1, (scenes) => {
    const t = node("text", "Headline", 20, 15, 180, 120);
    t.type = "TEXT";
    t.text = {
      characters: text,
      fontName: { family: "Arial", style: "Regular" },
      fontSize: 22,
      lineHeight: { unit: "PIXELS", value: 28 },
      textAlignHorizontal: "CENTER",
      segments: [
        {
          start: 0,
          end: text.length,
          fontName: { family: "Arial", style: "Regular" },
          fontSize: 22,
          lineHeight: { unit: "PIXELS", value: 28 },
          fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }],
        },
      ],
    };
    scenes[0].children = [t];
    scenes[0].width = 240;
    scenes[0].height = 180;
  });
  const state = structuredClone(fixture.state);
  state.settings = {
    ...state.settings,
    width: 240,
    height: 180,
    durationFrames: 100,
  };
  state.blocks[0].durationFrames = 100;
  const common = {
    targetId: "text",
    sceneId: "s0",
    startFrame: 0,
    durationFrames: 40,
    easing: "linear" as const,
    enabled: true,
    text: settings,
  };
  const animations: Animation[] = [
    {
      ...common,
      animationId: "slide",
      effect: "slideDown",
      parameters: { distance: 30, mode: "in" },
    },
    {
      ...common,
      animationId: "fade",
      effect: "fadeIn",
      parameters: { from: 0, to: 1 },
    },
  ];
  const active = applyOperations(
    state,
    animations.map((animation) => ({
      type: "addAnimation" as const,
      animation,
    })),
    fixture.project,
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 240, height: 180 },
    });
    await page.setContent((await motionHtml(fixture.project, active)).html);
    await page.evaluate(() => window.motionReady);
    const layout = await page
      .locator("[data-text-layout]")
      .getAttribute("data-text-layout");
    assert.ok(layout);
    const snapshot = JSON.parse(layout!);
    assert.equal(snapshot.lines.length, 3);
    assert.equal(snapshot.text, text);
    assert.deepEqual(snapshot.explicitBreaks, [9, 22]);
    const capture = async (frame: number) => {
      await page.evaluate((f) => window.motionFrame(f), frame);
      return page.locator("[data-text-animation]").evaluate((e) => e.innerHTML);
    };
    const frame20 = await capture(20);
    for (const frame of [0, 10, 40, 80]) await capture(frame);
    assert.equal(await capture(20), frame20);
    await capture(0);
    const bounds = await page
      .locator("[data-text-animation] > g > g")
      .evaluateAll((es) =>
        es.map((e) => {
          const b = JSON.parse(e.getAttribute("data-text-unit-bounds")!);
          const m = (e as unknown as SVGGraphicsElement).getScreenCTM()!;
          const ps = [
            [b.x, b.y],
            [b.x + b.width, b.y],
            [b.x, b.y + b.height],
            [b.x + b.width, b.y + b.height],
          ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(m));
          return {
            bottom: Math.max(...ps.map((p) => p.y)),
            opacity: e.getAttribute("opacity"),
          };
        }),
      );
    assert.ok(bounds.length >= 3);
    assert.ok(bounds.every((b) => b.bottom <= 0.01));
    assert.ok(bounds.every((b) => b.opacity === "0"));
    await capture(35);
    const resting = await page
      .locator('[data-motion-target="text"]')
      .evaluate((el) => {
        const source = el.querySelector("foreignObject[data-text-source]")!;
        const span = source.querySelector('[data-text-start="0"]')!;
        const mover = el.querySelector("[data-text-unit-bounds]")!;
        const b = JSON.parse(mover.getAttribute("data-text-unit-bounds")!);
        const pt = new DOMPoint(b.x, b.y).matrixTransform(
          (mover as SVGGraphicsElement).getScreenCTM()!,
        );
        return { source: span.getBoundingClientRect().top, slice: pt.y };
      });
    assert.ok(Math.abs(resting.source - resting.slice) < 0.01);
    await capture(80);
    const final = await page.screenshot();
    await page.evaluate((s) => window.motionUpdate(s), state);
    assert.deepEqual(await page.screenshot(), final);
    const inertia = {
      expressionId: "inertia",
      type: "inertialOvershoot" as const,
      property: "y" as const,
      sourceAnimationId: "slide",
      targetId: "text",
      sceneId: "s0",
      startFrame: 40,
      durationFrames: 30,
      enabled: true,
      parameters: {
        mode: "ae" as const,
        amplitude: 0.1,
        frequency: 2,
        decay: 3,
        velocityLookbackFrames: 3,
      },
    };
    await page.evaluate((s) => window.motionUpdate(s), {
      ...active,
      expressions: [inertia],
    });
    await page.evaluate(() => window.motionFrame(46));
    const inertial = await page
      .locator("[data-text-unit-bounds]")
      .evaluateAll((es) => es.map((e) => e.getAttribute("transform")));
    assert.ok(inertial.some((t) => t !== "translate(0 0)"));
    await page.evaluate(() => window.motionFrame(80));
    assert.deepEqual(await page.screenshot(), final);
    const motionDocument = await readMotion(fixture.project);
    motionDocument.state = active;
    await writeFile(
      fixture.project.root + "/motion/motion.json",
      JSON.stringify(motionDocument),
    );
    const video = await exportVideo(fixture.project.root);
    const ffmpeg = createRequire(import.meta.url)("ffmpeg-static") as string;
    const differences = [];
    for (const frame of [10, 20, 45]) {
      await page.evaluate((s) => window.motionUpdate(s), active);
      await page.evaluate((f) => window.motionFrame(f), frame);
      const preview = await page.screenshot();
      const decoded = await promisify(execFile)(
        ffmpeg,
        [
          "-v",
          "error",
          "-i",
          fixture.project.root + "/renders/" + video.file,
          "-vf",
          `select=eq(n\\,${frame})`,
          "-frames:v",
          "1",
          "-f",
          "image2pipe",
          "-vcodec",
          "png",
          "-",
        ],
        { encoding: "buffer", maxBuffer: 5000000 },
      );
      const difference = await page.evaluate(
        async (sources) => {
          const pixels = await Promise.all(
            sources.map(async (src) => {
              const image = new Image();
              image.src = src;
              await image.decode();
              const canvas = document.createElement("canvas");
              canvas.width = image.width;
              canvas.height = image.height;
              const ctx = canvas.getContext("2d")!;
              ctx.drawImage(image, 0, 0);
              return ctx.getImageData(0, 0, image.width, image.height).data;
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
      differences.push({ frame, difference });
    }
    console.log(JSON.stringify({ textVideoParity: differences }));
  } finally {
    await browser.close();
    await fixture.cleanup();
  }
});

test("word/grapheme snapshots retain Unicode, wrapping, repeated spaces and mixed style runs; local masks stay fixed", async () => {
  const content = "AV fi  A\u0301 👨‍👩‍👧‍👦\nЖ9 — Hello world wrapping";
  const f = await identityFixture(1, (scenes) => {
    const t = node("text", "Headline", 5, 5, 100, 140);
    t.type = "TEXT";
    t.text = {
      characters: content,
      textAlignHorizontal: "RIGHT",
      segments: [
        {
          start: 0,
          end: content.indexOf("\n"),
          fontName: { family: "Arial", style: "Bold" },
          fontWeight: 700,
          fontSize: 18,
          lineHeight: { unit: "PIXELS", value: 24 },
        },
        {
          start: content.indexOf("\n"),
          end: content.length,
          fontName: { family: "Arial", style: "Regular" },
          fontWeight: 400,
          fontSize: 18,
          lineHeight: { unit: "PIXELS", value: 24 },
        },
      ],
    };
    scenes[0].children = [t];
  });
  const state = structuredClone(f.state);
  state.settings = {
    ...state.settings,
    width: 200,
    height: 180,
    durationFrames: 100,
  };
  state.blocks[0].durationFrames = 100;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 200, height: 180 },
    });
    const base = (await motionHtml(f.project, state)).html;
    await page.setContent(base);
    await page.evaluate(() => window.motionReady);
    const baseline = await page.screenshot();
    for (const segmentation of ["word", "character"] as const) {
      const cfg = {
        ...settings,
        segmentation,
        staggerFrames: 1,
        origin: "masked" as const,
      };
      const a: Animation = {
        animationId: "letters",
        targetId: "text",
        sceneId: "s0",
        startFrame: 0,
        durationFrames: 80,
        easing: "easeOutCubic",
        enabled: true,
        effect: "slideUp",
        parameters: { distance: 24, mode: "in" },
        text: cfg,
      };
      await page.evaluate((s) => window.motionUpdate(s), {
        ...state,
        animations: [a],
      });
      const snapshot = JSON.parse(
        (await page
          .locator("[data-text-layout]")
          .getAttribute("data-text-layout"))!,
      );
      assert.equal(snapshot.text, content);
      assert.ok(snapshot.lines.length > 2);
      assert.ok(
        snapshot.characters.some((u: { text: string }) => u.text === "A\u0301"),
      );
      assert.ok(
        snapshot.characters.some((u: { text: string }) => u.text === "👨‍👩‍👧‍👦"),
      );
      await page.evaluate(() => window.motionFrame(20));
      const fixed = await page
        .locator('clipPath[id$="-fixed"]')
        .evaluateAll((es) => es.map((e) => e.outerHTML));
      const before = await page.screenshot();
      await page.evaluate(() => window.motionFrame(50));
      assert.deepEqual(
        await page
          .locator('clipPath[id$="-fixed"]')
          .evaluateAll((es) => es.map((e) => e.outerHTML)),
        fixed,
      );
      await page.evaluate(() => window.motionFrame(20));
      assert.deepEqual(await page.screenshot(), before);
      await page.evaluate(() => window.motionFrame(90));
      assert.deepEqual(await page.screenshot(), baseline);
      const timing = await page.evaluate(() => {
        const samples = [];
        for (let i = 0; i < 80; i++) {
          const begin = performance.now();
          window.motionFrame(i);
          samples.push(performance.now() - begin);
        }
        samples.sort((a, b) => a - b);
        return { p50Ms: samples[40], p95Ms: samples[76] };
      });
      console.log(
        JSON.stringify({
          frameEvaluation: timing,
          mode: segmentation,
          lines: snapshot.lines.length,
          units:
            snapshot[segmentation === "word" ? "words" : "characters"].length,
          layoutMs: snapshot.preparationMs,
        }),
      );
    }
  } finally {
    await browser.close();
    await f.cleanup();
  }
});

test("text effects reject non-native targets, incompatible segment contracts and unsupported sliced transforms", async () => {
  const f = await identityFixture(1);
  try {
    const a: Animation = {
      animationId: "t",
      targetId: "root0",
      sceneId: "s0",
      startFrame: 0,
      durationFrames: 5,
      easing: "linear",
      enabled: true,
      effect: "fadeIn",
      parameters: { from: 0, to: 1 },
      text: settings,
    };
    assert.throws(
      () =>
        applyOperations(
          f.state,
          [{ type: "addAnimation", animation: a }],
          f.project,
        ),
      /TEXT_NATIVE_LAYOUT_REQUIRED/,
    );
  } finally {
    await f.cleanup();
  }
  const native = await identityFixture(1, (scenes) => {
    const t = node("text", "Text");
    t.type = "TEXT";
    t.text = { characters: "Test" };
    scenes[0].children = [t];
  });
  try {
    const base: Animation = {
      animationId: "base",
      targetId: "text",
      sceneId: "s0",
      startFrame: 0,
      durationFrames: 5,
      easing: "linear",
      enabled: true,
      effect: "fadeIn",
      parameters: { from: 0, to: 1 },
      text: settings,
    };
    assert.throws(
      () =>
        applyOperations(
          native.state,
          [
            {
              type: "addAnimation",
              animation: {
                ...base,
                effect: "rotation",
                parameters: { from: 0, to: 10 },
              },
            },
          ],
          native.project,
        ),
      /TEXT_SEGMENT_EFFECT_UNSUPPORTED/,
    );
    assert.throws(
      () =>
        applyOperations(
          native.state,
          [
            { type: "addAnimation", animation: base },
            {
              type: "addAnimation",
              animation: {
                ...base,
                animationId: "other",
                effect: "slideUp",
                parameters: { distance: 20, mode: "in" },
                text: { ...settings, segmentation: "word" },
              },
            },
          ],
          native.project,
        ),
      /TEXT_SEGMENT_SETTINGS_CONFLICT/,
    );
  } finally {
    await native.cleanup();
  }
});

test("each line clears the viewport through a rotated, nonuniformly scaled parent plane", async () => {
  const f = await identityFixture(1, (scenes) => {
    const t = node("text", "Text", 0, 0, 120, 70);
    t.type = "TEXT";
    t.sceneTransform = [
      [1.1, -0.35, 53.5],
      [0.6, 0.7, 29],
    ];
    t.text = {
      characters: "One\nTwo",
      fontSize: 20,
      fontName: { family: "Arial", style: "Regular" },
      lineHeight: { unit: "PIXELS", value: 26 },
    };
    const group = node("group", "Group", 0, 0, 180, 100, [t]);
    group.type = "GROUP";
    group.sceneTransform = [
      [1.1, -0.35, 35],
      [0.6, 0.7, 10],
    ];
    scenes[0].children = [group];
  });
  const state = structuredClone(f.state);
  state.settings.durationFrames = 50;
  state.blocks[0].durationFrames = 50;
  state.animations = [
    {
      animationId: "text",
      targetId: "text",
      sceneId: "s0",
      effect: "slideDown",
      parameters: { distance: 10, mode: "in" },
      startFrame: 0,
      durationFrames: 30,
      easing: "linear",
      enabled: true,
      text: { ...settings, staggerFrames: 3 },
    },
  ];
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: state.settings.width, height: state.settings.height },
    });
    await page.setContent((await motionHtml(f.project, state)).html);
    await page.evaluate(() => window.motionReady);
    const bottoms = await page
      .locator("[data-text-unit-bounds]")
      .evaluateAll((es) =>
        es.map((e) => {
          const b = JSON.parse(e.getAttribute("data-text-unit-bounds")!);
          const m = (e as SVGGraphicsElement).getScreenCTM()!;
          return Math.max(
            ...[
              [b.x, b.y],
              [b.x + b.width, b.y],
              [b.x, b.y + b.height],
              [b.x + b.width, b.y + b.height],
            ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(m).y),
          );
        }),
      );
    assert.equal(bottoms.length, 2);
    assert.ok(bottoms.every((y) => y < 0));
  } finally {
    await browser.close();
    await f.cleanup();
  }
});
