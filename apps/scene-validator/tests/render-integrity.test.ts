import test from "node:test";
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";
import { build } from "esbuild";
import { identityFixture, node } from "./identity-fixture.js";
import { motionHtml } from "../src/motion/presentation.js";
import { isolateObject, inspectObject } from "../src/motion/qa/geometry.js";
async function diff(page: Page, a: Buffer, b: Buffer) {
  return page.evaluate(
    async ({ a, b }) => {
      const decoded: Uint8ClampedArray[] = [];
      for (const bytes of [a, b]) {
        const i = new Image();
        i.src = "data:image/png;base64," + bytes;
        await i.decode();
        const c = document.createElement("canvas");
        c.width = i.width;
        c.height = i.height;
        const x = c.getContext("2d")!;
        x.drawImage(i, 0, 0);
        decoded.push(x.getImageData(0, 0, c.width, c.height).data);
      }
      let n = 0;
      for (let i = 0; i < decoded[0].length; i += 4)
        if (
          [0, 1, 2, 3].some(
            (j) => Math.abs(decoded[0][i + j] - decoded[1][i + j]) > 8,
          )
        )
          n++;
      return n;
    },
    { a: a.toString("base64"), b: b.toString("base64") },
  );
}
const revealBundle = () =>
  build({
    entryPoints: ["apps/scene-validator/src/motion/path-reveal.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "testReveal",
    platform: "browser",
  });
test("SVG reveal: native/Bezier/thick/round/outlined gradient/nested transforms/multi paths preserve final pixels, source masks and source geometry", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const bundle = (await revealBundle()).outputFiles![0].text;
    const variants = [
      '<path d="M30 50 L170 50" stroke="red" stroke-width="8" fill="none"/>',
      '<path d="M30 80 C40 10 150 10 170 80" stroke="red" stroke-width="8" fill="none"/>',
      '<path d="M40 80 L160 80" stroke="red" stroke-width="60" stroke-linecap="round" fill="none"/>',
      '<path d="M20 40 H180 V80 H20 Z" fill="url(#g)" data-motion-centerline="M20 60 H180" data-motion-stroke-width="40"/>',
      '<g transform="translate(20 10) rotate(10)"><path transform="scale(.8)" d="M30 80 C40 10 150 10 170 80" stroke="red" stroke-width="8" fill="none"/></g>',
      '<path d="M20 30 H180" stroke="red" stroke-width="8" fill="none"/><path d="M20 80 H180" stroke="red" stroke-width="8" fill="none"/>',
      '<path mask="url(#source)" d="M20 60 H180" stroke="red" stroke-width="20" fill="none"/>',
    ];
    for (const svg of variants) {
      const page = await browser.newPage({
        viewport: { width: 220, height: 140 },
      });
      await page.setContent(
        `<style>body{margin:0}</style><svg width="220" height="140"><defs><linearGradient id="g"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient><mask id="source" maskUnits="userSpaceOnUse"><rect x="60" width="80" height="140" fill="white"/></mask></defs>${svg}</svg>`,
      );
      await page.addScriptTag({ content: bundle });
      const baseline = await page.screenshot({ omitBackground: true });
      const before = await page
        .locator("svg > path,svg > g path")
        .evaluateAll((ps) => ps.map((p) => p.outerHTML));
      await page.evaluate(() => {
        for (const p of document.querySelectorAll<SVGGeometryElement>(
          "svg > path,svg > g path",
        ))
          (
            window as unknown as { testReveal: { pathReveal: Function } }
          ).testReveal.pathReveal(p, 0.5);
      });
      const half = await page.screenshot({ omitBackground: true });
      assert.ok((await diff(page, baseline, half)) > 0, svg);
      await page.evaluate(() => {
        for (const p of document.querySelectorAll<SVGGeometryElement>(
          "[data-motion-effect-mask] > path",
        ))
          (
            window as unknown as { testReveal: { pathReveal: Function } }
          ).testReveal.pathReveal(p, 1);
      });
      const final = await page.screenshot({ omitBackground: true });
      assert.equal(await diff(page, baseline, final), 0, svg);
      assert.deepEqual(
        await page
          .locator("[data-motion-effect-mask] > path")
          .evaluateAll((ps) => ps.map((p) => p.outerHTML)),
        before,
      );
      await page.evaluate(() => {
        for (const p of document.querySelectorAll<SVGGeometryElement>(
          "[data-motion-effect-mask] > path",
        ))
          (
            window as unknown as { testReveal: { pathReveal: Function } }
          ).testReveal.pathReveal(p, undefined);
      });
      assert.equal(
        await page
          .locator("[data-motion-effect-mask], [data-motion-reveal]")
          .count(),
        0,
      );
      await page.close();
    }
    const page = await browser.newPage({
      viewport: { width: 220, height: 140 },
    });
    await page.setContent(
      '<style>body{margin:0}</style><svg width="220" height="140"><g id="hidden" style="display:none" transform="translate(10 20)"><path d="M20 30 H180" stroke="red" stroke-width="20" fill="none"/></g></svg>',
    );
    await page.addScriptTag({ content: bundle });
    await page.evaluate(() => {
      const p = document.querySelector("path")!;
      (
        window as unknown as { testReveal: { pathReveal: Function } }
      ).testReveal.pathReveal(p, 0);
    });
    assert.ok(
      await page
        .locator("mask")
        .evaluate((m) => Number(m.getAttribute("width")) > 160),
    );
    await page.evaluate(() => {
      document.getElementById("hidden")!.style.display = "";
      const p = document.querySelector("[data-motion-effect-mask] > path")!;
      (
        window as unknown as { testReveal: { pathReveal: Function } }
      ).testReveal.pathReveal(p, 0.5);
    });
    const half = await page.screenshot({ omitBackground: true });
    await page.evaluate(() => {
      const p = document.querySelector("[data-motion-effect-mask] > path")!;
      (
        window as unknown as { testReveal: { pathReveal: Function } }
      ).testReveal.pathReveal(p, 1);
    });
    assert.ok(
      (await diff(
        page,
        half,
        await page.screenshot({ omitBackground: true }),
      )) > 0,
      "Hidden initialization must still render intermediate reveal",
    );
    await page.close();
  } finally {
    await browser.close();
  }
});
test("Text descenders remain intact through slide/fade/overshoot; isolated render retains intentional source clipping and geometry", async () => {
  const f = await identityFixture(1, (scenes) => {
    const t = node("text", "Descenders", 20, 30, 160, 10);
    t.type = "TEXT";
    t.text = {
      characters: "руфцщд gjpqy",
      fontName: { family: "Arial", style: "Regular" },
      fontSize: 22,
      lineHeight: { unit: "PIXELS", value: 12 },
      textAlignVertical: "TOP",
    };
    scenes[0].width = 240;
    scenes[0].height = 160;
    scenes[0].properties.width = 240;
    scenes[0].properties.height = 160;
    scenes[0].children = [t];
  });
  const browser = await chromium.launch({ headless: true });
  try {
    f.state.settings = {
      ...f.state.settings,
      width: 240,
      height: 160,
      durationFrames: 90,
      fps: 30,
    };
    f.state.blocks[0].durationFrames = 90;
    f.state.animations = [
      {
        animationId: "slide",
        sceneId: "s0",
        targetId: "text",
        effect: "slideUp",
        parameters: { distance: 10, mode: "in" },
        startFrame: 0,
        durationFrames: 30,
        easing: "linear",
        enabled: true,
      },
      {
        animationId: "fade",
        sceneId: "s0",
        targetId: "text",
        effect: "fadeIn",
        parameters: { from: 0, to: 1 },
        startFrame: 0,
        durationFrames: 30,
        easing: "linear",
        enabled: true,
      },
    ];
    f.state.expressions = [
      {
        expressionId: "inertia",
        sceneId: "s0",
        targetId: "text",
        type: "inertialOvershoot",
        property: "y",
        sourceAnimationId: "slide",
        startFrame: 30,
        durationFrames: 45,
        enabled: true,
        parameters: {
          amplitude: 0.1,
          frequency: 2,
          decay: 3,
          velocityLookbackFrames: 6,
        },
      },
    ];
    const page = await browser.newPage({
      viewport: { width: 240, height: 160 },
    });
    await page.setContent((await motionHtml(f.project, f.state)).html);
    await page.evaluate(() => window.motionReady);
    await page.evaluate(() => window.motionFrame(80));
    await isolateObject(page, "s0", "text");
    const final = await page.screenshot({ omitBackground: true });
    const d = await inspectObject(page, "s0", "text");
    assert.ok(d.text.some((t) => t.descent > 0));
    assert.equal(d.masks.length, 0);
    assert.equal(
      await page.locator('[data-motion-target="text"] [clip-path]').count(),
      0,
    );
    await page.evaluate(() => {
      document.querySelector("foreignObject")!.setAttribute("height", "120");
    });
    assert.equal(
      await diff(page, final, await page.screenshot({ omitBackground: true })),
      0,
      "Short text box must not clip descenders",
    );
    await page.evaluate(() => {
      document.querySelector("foreignObject")!.setAttribute("height", "10");
      document
        .querySelector("foreignObject")!
        .setAttribute("overflow", "hidden");
    });
    assert.ok(
      (await diff(
        page,
        final,
        await page.screenshot({ omitBackground: true }),
      )) > 0,
      "Probe must detect actual clipping",
    );
    await page.evaluate(() =>
      document
        .querySelector("foreignObject")!
        .setAttribute("overflow", "visible"),
    );
    const revealed = {
      ...f.state,
      animations: [
        ...f.state.animations,
        {
          animationId: "text-reveal",
          sceneId: "s0",
          targetId: "text",
          effect: "maskReveal" as const,
          parameters: { from: 0, to: 1, direction: "forward" as const },
          startFrame: 0,
          durationFrames: 30,
          easing: "linear" as const,
          enabled: true,
        },
      ],
    };
    await page.evaluate((s) => window.motionUpdate(s), revealed);
    await page.evaluate(() => window.motionFrame(15));
    assert.equal(
      await page
        .locator('[data-motion-effect-mask="textReveal"][clip-path]')
        .count(),
      1,
    );
    await page.evaluate(() => window.motionFrame(80));
    assert.equal(
      await diff(page, final, await page.screenshot({ omitBackground: true })),
      0,
      "Text Mask Reveal must restore exact final pixels without clipping descenders",
    );
    assert.equal(
      await page
        .locator('[data-motion-effect-mask="textReveal"][clip-path]')
        .count(),
      0,
    );
    await page.evaluate((s) => window.motionUpdate(s), f.state);
    assert.equal(
      await page.locator('[data-motion-effect-mask="textReveal"]').count(),
      0,
    );
    const sceneBefore = JSON.stringify(f.project.inspection.document);
    await page.evaluate(() => window.motionFrame(15));
    assert.equal(await page.locator("[data-motion-effect-mask]").count(), 0);
    assert.equal(JSON.stringify(f.project.inspection.document), sceneBefore);
  } finally {
    await browser.close();
    await f.cleanup();
  }
});

test("Scene-specific font aliases do not collide across scenes or change on project reopening; source clipping remains explicit", async () => {
  const f = await identityFixture(2, (scenes) => {
    for (let i = 0; i < 2; i++) {
      const t = node("t" + i, "Text", 10, 10, 160, 10);
      t.type = "TEXT";
      t.text = {
        characters: "gjpqy руфцщд",
        fontName: { family: i ? "Courier New" : "Arial", style: "Regular" },
        fontSize: 24,
      };
      scenes[i].children = [t];
    }
  });
  try {
    const first = await motionHtml(f.project, f.state);
    const aliases = [
      ...first.html.matchAll(/@font-face\{font-family:'([^']+)'/g),
    ].map((m) => m[1]);
    assert.equal(aliases.length, 2);
    assert.equal(
      new Set(aliases).size,
      2,
      "Each scene must own its font-face alias",
    );
    assert.ok(first.html.includes('data-clip-reason="source"'));
    assert.ok(first.html.includes('data-clip-reason="scene"'));
    const { loadProject } = await import("../src/project.js");
    assert.equal(
      (await motionHtml(await loadProject(f.project.root), f.state)).html,
      first.html,
    );
  } finally {
    await f.cleanup();
  }
});

test("Text Mask Reveal uses typed reveal channel, real render QA and restores full text without Fade substitution", async () => {
  const f = await identityFixture(1, (scenes) => {
    const t = node("text", "Text", 20, 20, 160, 10);
    t.type = "TEXT";
    t.text = {
      characters: "gjpqy руфцщд",
      fontName: { family: "Arial", style: "Regular" },
      fontSize: 24,
    };
    scenes[0].children = [t];
  });
  try {
    f.state.settings = { ...f.state.settings, fps: 30, durationFrames: 90 };
    f.state.blocks[0].durationFrames = 90;
    f.state.animations = [
      {
        animationId: "mask",
        sceneId: "s0",
        targetId: "text",
        effect: "maskReveal",
        parameters: { from: 0, to: 1, direction: "forward" },
        startFrame: 0,
        durationFrames: 30,
        easing: "linear",
        enabled: true,
      },
    ];
    const { motionQA } = await import("../src/motion/qa/render.js");
    const qa = await motionQA(
      f.project,
      f.state,
      "motion/qa/mask",
      "Explicit Text Mask Reveal",
    );
    assert.notEqual(qa.status, "FAILED");
    assert.equal(
      qa.checks.find((c) => c.name === "TEXT_MASK_REVEAL")?.status,
      "PASSED",
    );
    assert.equal(
      qa.checks.find((c) => c.name === "FINAL_STATE_MATCH")?.status,
      "PASSED",
    );
    assert.equal(
      qa.checks.find((c) => c.name === "TEXT_GLYPH_INTEGRITY")?.status,
      "PASSED",
    );
  } finally {
    await f.cleanup();
  }
});
