import test from "node:test";
import assert from "node:assert/strict";
import { chromium, webkit, type Page } from "playwright";
import { identityFixture, node } from "./identity-fixture.js";
import { multiply, type Matrix } from "../src/renderer.js";
import { motionHtml, sceneThumbnailHtml } from "../src/motion/presentation.js";
import { changeMotion, readMotion } from "../src/motion/store.js";
import { loadProject } from "../src/project.js";
import { createProject } from "../src/importer.js";
import { readFile, writeFile } from "node:fs/promises";
import { exportVideo } from "../src/motion/video.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import path from "node:path";
import type { SourceNode } from "../src/motion/registry.js";
import type { Animation, MotionState } from "../src/motion/schema.js";

// Pixel bounds, not getBoundingClientRect: WebKit reported correct DOM geometry
// while painting transformed foreignObject HTML at the scene origin.
async function pixels(page: Page, supplied?: Buffer) {
  const png = supplied ?? (await page.screenshot());
  return page.evaluate(
    async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const boxes = [
        { x: Infinity, y: Infinity, right: 0, bottom: 0, count: 0 },
        { x: Infinity, y: Infinity, right: 0, bottom: 0, count: 0 },
      ];
      for (let y = 0; y < canvas.height; y++)
        for (let x = 0; x < canvas.width; x++) {
          const k = (y * canvas.width + x) * 4;
          const index =
            d[k] > 80 && d[k] > 2 * d[k + 1] && d[k] > 2 * d[k + 2]
              ? 0
              : d[k + 2] > 80 && d[k + 2] > 2 * d[k] && d[k + 2] > 2 * d[k + 1]
                ? 1
                : -1;
          if (index < 0) continue;
          const b = boxes[index];
          b.x = Math.min(b.x, x);
          b.y = Math.min(b.y, y);
          b.right = Math.max(b.right, x);
          b.bottom = Math.max(b.bottom, y);
          b.count++;
        }
      return boxes;
    },
    "data:image/png;base64," + png.toString("base64"),
  );
}
function near(
  actual: Awaited<ReturnType<typeof pixels>>,
  expected: Awaited<ReturnType<typeof pixels>>,
  label: string,
) {
  for (let i = 0; i < 2; i++) {
    assert.ok(
      actual[i].count > 0,
      label + ": visible pixels " + JSON.stringify({ actual, expected }),
    );
    for (const k of ["x", "y", "right", "bottom"] as const)
      assert.ok(
        Math.abs(actual[i][k] - expected[i][k]) <= 2,
        `${label}: ${i}.${k}: ${actual[i][k]} vs ${expected[i][k]}`,
      );
  }
}
for (const [engine, launcher] of Object.entries({ chromium, webkit })) {
  test(`${engine}: source-to-pixel text placement, compound rest, nested transforms, resize, seek and removal`, async () => {
    const fixture = await identityFixture(1, (scenes) => {
      const t = node("text", "Text", 0, 0, 240, 100);
      t.type = "TEXT";
      t.text = {
        characters: "Alpha beta\nGamma",
        fontName: { family: "Arial", style: "Regular" },
        fontSize: 24,
        lineHeight: { unit: "PIXELS", value: 32 },
        textAlignHorizontal: "CENTER",
        textAlignVertical: "CENTER",
        textAutoResize: "NONE",
      };
      t.properties.fills = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }];
      const parent = node("parent", "Parent", 100, 80, 450, 300, [t]);
      parent.type = "GROUP";
      parent.properties.fills = [];
      const angle = 0.12;
      const m: Matrix = [
        [Math.cos(angle) * 1.1, -Math.sin(angle) * 0.9, 100],
        [Math.sin(angle) * 1.1, Math.cos(angle) * 0.9, 80],
      ];
      parent.sceneTransform = m;
      t.sceneTransform = multiply(m, [
        [1, 0, 70],
        [0, 1, 55],
      ]);
      const square = node("square", "Square", 520, 350, 30, 30);
      square.properties.fills = [
        { type: "SOLID", color: { r: 0, g: 0, b: 1 } },
      ];
      scenes[0].width = 640;
      scenes[0].height = 480;
      scenes[0].properties.width = 640;
      scenes[0].properties.height = 480;
      scenes[0].children = [parent, square];
    });
    const original = await readFile(fixture.project.scenePath, "utf8");
    const browser = await launcher.launch({ headless: true });
    try {
      const page = await browser.newPage({
        viewport: { width: 640, height: 480 },
      });
      const state = structuredClone(fixture.state);
      state.settings = {
        ...state.settings,
        width: 640,
        height: 480,
        durationFrames: 100,
      };
      state.blocks[0].durationFrames = 100;
      const common = {
        sceneId: "s0",
        targetId: "text",
        startFrame: 0,
        durationFrames: 30,
        easing: "linear" as const,
        enabled: true,
      };
      for (const alignment of ["LEFT", "CENTER", "RIGHT"]) {
        const project = await loadProject(fixture.project.root);
        const t = (
          project.inspection.document.scenes[0].children[0] as SourceNode
        ).children[0];
        // Isolated in-memory fixture variants; no source/layout compensation.
        (t.text as Record<string, unknown>).textAlignHorizontal = alignment;
        (t.text as Record<string, unknown>).textAutoResize =
          alignment === "RIGHT"
            ? "HEIGHT"
            : alignment === "LEFT"
              ? "WIDTH_AND_HEIGHT"
              : "NONE";
        if (alignment === "RIGHT")
          (t.text as Record<string, unknown>).fontName = {
            family: "AKELLA-Intentionally-Missing-Font-Regression",
            style: "Regular",
          };
        project.inspection.fingerprint += "-" + alignment;
        await page.setContent(await sceneThumbnailHtml(project, "s0"));
        await page.evaluate(() => document.fonts.ready);
        const reference = await pixels(page);
        assert.ok(reference[0].x > 140 && reference[0].y > 100);
        await page.setContent((await motionHtml(project, state)).html);
        await page.evaluate(() => window.motionReady);
        near(await pixels(page), reference, alignment + " static");
        if (engine === "webkit" && alignment === "LEFT") {
          // Exact negative control for the former regression, not a mocked matrix.
          await page.locator("foreignObject > div").evaluateAll((es) =>
            es.forEach((e) => {
              (e as HTMLElement).style.transform = "translate3d(0,0,0)";
              (e as HTMLElement).style.willChange = "transform,opacity";
            }),
          );
          const broken = await pixels(page);
          assert.ok(broken[0].x < reference[0].x - 50);
          await page.setContent((await motionHtml(project, state)).html);
          await page.evaluate(() => window.motionReady);
        }
        for (const [segmentation, fade, slide, inertia] of [
          ["block", false, true, false],
          ["block", true, false, false],
          ["line", false, true, false],
          ["line", true, false, false],
          ["line", true, true, false],
          ["line", false, true, true],
          ["word", true, true, false],
          ["character", true, true, false],
        ] as const) {
          const text = {
            segmentation,
            timing: "simultaneous" as const,
            staggerFrames: 0,
            origin: "local" as const,
            reverse: false,
          };
          const animations: Animation[] = [];
          if (slide)
            animations.push({
              ...common,
              text,
              animationId: "slide",
              effect: "slideDown",
              parameters: { distance: 40, mode: "in" },
            });
          if (fade)
            animations.push({
              ...common,
              text,
              animationId: "fade",
              effect: "fadeIn",
              parameters: { from: 0, to: 1 },
            });
          const active: MotionState = {
            ...state,
            animations,
            expressions: inertia
              ? [
                  {
                    expressionId: "inertia",
                    type: "inertialOvershoot",
                    property: "y",
                    sourceAnimationId: "slide",
                    targetId: "text",
                    sceneId: "s0",
                    startFrame: 30,
                    durationFrames: 30,
                    enabled: true,
                    parameters: {
                      mode: "ae",
                      amplitude: 0.1,
                      frequency: 2,
                      decay: 3,
                      velocityLookbackFrames: 3,
                    },
                  },
                ]
              : [],
          };
          await page.evaluate((s) => window.motionUpdate(s), active);
          for (const f of [75, 12, 0, 43, 99, 75])
            await page.evaluate((f) => window.motionFrame(f), f);
          near(
            await pixels(page),
            reference,
            `${alignment} ${segmentation} ${fade}/${slide}/${inertia} rest`,
          );
          // Random access must reproduce actual pixels, not merely equal transforms.
          await page.evaluate(() => window.motionFrame(15));
          const middle = await pixels(page);
          await page.evaluate(() => {
            window.motionFrame(90);
            window.motionFrame(15);
          });
          assert.deepEqual(await pixels(page), middle);
          await page.evaluate((s) => window.motionUpdate(s), {
            ...active,
            animations: active.animations.map((a) => ({
              ...a,
              durationFrames: 25,
            })),
            expressions: [],
          });
          await page.evaluate(() => window.motionFrame(75));
          near(await pixels(page), reference, "edit rest");
          await page.evaluate((s) => window.motionUpdate(s), state);
          near(await pixels(page), reference, "remove rest");
        }
        await page.setViewportSize({ width: 320, height: 240 });
        await page.setContent(await sceneThumbnailHtml(project, "s0"));
        await page.evaluate(() => document.fonts.ready);
        const small = await pixels(page);
        await page.setContent((await motionHtml(project, state)).html);
        await page.evaluate(() => window.motionReady);
        near(await pixels(page), small, "viewport resize");
        await page.setViewportSize({ width: 640, height: 480 });
      }
      // Actual persistence path: create/edit/remove followed by reload and raster check.
      const loaded = await loadProject(fixture.project.root);
      await page.setContent(await sceneThumbnailHtml(loaded, "s0"));
      await page.evaluate(() => document.fonts.ready);
      const savedReference = await pixels(page);
      let doc = await readMotion(loaded);
      for (const operations of [
        [
          {
            type: "addAnimation",
            animation: {
              sceneId: "s0",
              targetId: "text",
              animationId: "saved",
              effect: "fadeIn",
              startFrame: 0,
              durationFrames: 6,
              easing: "linear",
              enabled: true,
              parameters: { from: 0, to: 1 },
            },
          },
        ],
        [
          {
            type: "updateAnimation",
            animationId: "saved",
            animation: {
              sceneId: "s0",
              targetId: "text",
              animationId: "saved",
              effect: "fadeIn",
              startFrame: 0,
              durationFrames: 5,
              easing: "linear",
              enabled: true,
              parameters: { from: 0, to: 1 },
            },
          },
        ],
        [{ type: "removeAnimation", animationId: "saved" }],
      ]) {
        doc = (
          await changeMotion(loaded.root, {
            expectedRevision: doc.revision,
            request: "placement persistence regression",
            operations,
          })
        ).document;
        const reloaded = await loadProject(loaded.root),
          persisted = await readMotion(reloaded);
        assert.deepEqual(persisted.state, doc.state);
        await page.setContent(
          (await motionHtml(reloaded, persisted.state)).html,
        );
        await page.evaluate(() => window.motionReady);
        await page.evaluate(() => window.motionFrame(11));
        near(await pixels(page), savedReference, "saved/reloaded");
      }
      if (engine === "webkit") {
        const videoState = structuredClone(fixture.state);
        videoState.settings = {
          ...videoState.settings,
          width: 640,
          height: 480,
          durationFrames: 12,
        };
        videoState.blocks[0].durationFrames = 12;
        const text = {
          segmentation: "line" as const,
          timing: "simultaneous" as const,
          staggerFrames: 0,
          origin: "local" as const,
          reverse: false,
        };
        videoState.animations = [
          {
            sceneId: "s0",
            targetId: "text",
            animationId: "video-slide",
            startFrame: 0,
            durationFrames: 6,
            easing: "linear",
            enabled: true,
            text,
            effect: "slideDown",
            parameters: { distance: 30, mode: "in" },
          },
          {
            sceneId: "s0",
            targetId: "text",
            animationId: "video-fade",
            startFrame: 0,
            durationFrames: 6,
            easing: "linear",
            enabled: true,
            text,
            effect: "fadeIn",
            parameters: { from: 0, to: 1 },
          },
        ];
        const videoDoc = await readMotion(loaded);
        videoDoc.state = videoState;
        await writeFile(
          path.join(loaded.root, "motion/motion.json"),
          JSON.stringify(videoDoc),
        );
        const video = await exportVideo(loaded.root);
        const ffmpeg = createRequire(import.meta.url)(
          "ffmpeg-static",
        ) as string;
        await page.setContent((await motionHtml(loaded, videoState)).html);
        await page.evaluate(() => window.motionReady);
        const comparisons = [];
        for (const frame of [4, 7, 10]) {
          await page.evaluate((f) => window.motionFrame(f), frame);
          const previewPng = await page.screenshot();
          const preview = await pixels(page, previewPng);
          const decoded = await promisify(execFile)(
            ffmpeg,
            [
              "-v",
              "error",
              "-i",
              path.join(loaded.root, "renders", video.file),
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
          const rendered = await pixels(page, decoded.stdout);
          // H264 and browser font rasterization move thresholded edge pixels.
          // Keep exact placement checks above; compare decoded video by the
          // established mean-RGBA codec tolerance, not a brittle color-edge box.
          const difference = await page.evaluate(
            async (sources) => {
              const arrays = [];
              for (const src of sources) {
                const image = new Image();
                image.src = src;
                await image.decode();
                const canvas = document.createElement("canvas");
                canvas.width = image.width;
                canvas.height = image.height;
                const ctx = canvas.getContext("2d")!;
                ctx.drawImage(image, 0, 0);
                arrays.push(
                  ctx.getImageData(0, 0, canvas.width, canvas.height).data,
                );
              }
              let sum = 0;
              for (let i = 0; i < arrays[0].length; i++)
                sum += Math.abs(arrays[0][i] - arrays[1][i]);
              return sum / arrays[0].length;
            },
            [previewPng, decoded.stdout].map(
              (b) => "data:image/png;base64," + b.toString("base64"),
            ),
          );
          assert.ok(
            difference < 3,
            `WebKit Preview/MP4 frame ${frame}: mean RGBA error ${difference}`,
          );
          comparisons.push({ frame, difference, preview, rendered });
        }
        console.log(JSON.stringify({ textPlacementVideo: comparisons }));
        videoDoc.state = fixture.state;
        await writeFile(
          path.join(loaded.root, "motion/motion.json"),
          JSON.stringify(videoDoc),
        );
      }
      const emptyProject = await loadProject(fixture.project.root);
      const emptyText = (
        emptyProject.inspection.document.scenes[0].children[0] as SourceNode
      ).children[0];
      (emptyText.text as Record<string, unknown>).characters = "";
      emptyProject.inspection.fingerprint += "-empty";
      await page.setContent(
        (
          await motionHtml(
            emptyProject,
            (await readMotion(fixture.project)).state,
          )
        ).html,
      );
      await page.evaluate(() => window.motionReady);
      const emptyPixels = await pixels(page);
      assert.equal(emptyPixels[0].count, 0);
      assert.ok(emptyPixels[1].count > 0);
      const imported = await createProject({
        source: fixture.source,
        name: "Second import",
        projectsRoot: path.join(fixture.root, "again"),
      });
      assert.equal(
        await readFile(
          (await loadProject(imported.projectPath)).scenePath,
          "utf8",
        ),
        original,
      );
      assert.equal(await readFile(fixture.project.scenePath, "utf8"), original);
    } finally {
      await browser.close();
      await fixture.cleanup();
    }
  });
}
