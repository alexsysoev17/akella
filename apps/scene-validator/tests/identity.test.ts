import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  buildRegistry,
  logicalId,
  resolveState,
  type SourceNode,
} from "../src/motion/registry.js";
import { applyOperations } from "../src/motion/operations.js";
import {
  statePresentation,
  transitionDiagnostics,
} from "../src/motion/transitions.js";
import {
  interpolateState,
  transitionProgress,
} from "../src/motion/transition-runtime.js";
import { motionHtml, sceneThumbnailHtml } from "../src/motion/presentation.js";
import { readMotion, changeMotion } from "../src/motion/store.js";
import { buildContext } from "../src/motion/context.js";
import { runAutonomous, resolveTarget } from "../src/motion/autonomy.js";
import { loadProject } from "../src/project.js";
import { createProject } from "../src/importer.js";
import { inventory, fingerprint } from "../src/files.js";
import { exportVideo } from "../src/motion/video.js";
import { identityFixture, node } from "./identity-fixture.js";
const operation = (
  t: Awaited<ReturnType<typeof identityFixture>>["transition"],
) => ({ type: "animateObjectStateTransition", ...t });

test("exact identity: root excluded, names case-sensitive, absent states, 15 scenes and duplicate references", async () => {
  const f = await identityFixture(15, (scenes) => {
    scenes[1].children.push(
      node("quan", "QUAN"),
      node("logo", "Logo"),
      node("lower", "logo"),
    );
    scenes[3].children.push(node("duplicate", "QR"));
  });
  try {
    const r = buildRegistry(f.project.inspection.document),
      qr = r.objects.find((o) => o.name === "QR")!;
    assert.equal(r.objects.length, 4);
    assert.equal(qr.sourceInstances.length, 15);
    assert.equal(qr.states.length, 13);
    assert.deepEqual(qr.ambiguousScenes, ["s3"]);
    assert.ok(r.diagnostics.length);
    assert.equal(
      qr.states.some((s) => s.sceneId === "s0"),
      false,
    );
    assert.notEqual(logicalId("Logo"), logicalId("logo"));
    assert.notEqual(logicalId("QR"), logicalId("QR "));
    assert.throws(
      () => resolveState(f.project.inspection.document, qr, "s3"),
      /неоднозначно/,
    );
    const valid = applyOperations(
      f.state,
      [operation(f.transition)],
      f.project,
    );
    assert.equal(valid.objectTransitions?.length, 1);
    assert.throws(
      () =>
        applyOperations(
          f.state,
          [operation({ ...f.transition, toSceneId: "s3" })],
          f.project,
        ),
      /неоднозначно/,
    );
  } finally {
    await f.cleanup();
  }
});

test("states resolve full hierarchy, global transforms and layer paths across reparenting", async () => {
  const f = await identityFixture(3, (scenes) => {
    const qr = scenes[1].children[0];
    qr.sceneTransform = [
      [0, -1, 160],
      [1, 0, 80],
    ];
    const group = node("group", "Product", 50, 20, 150, 100, [qr]);
    group.type = "GROUP";
    group.properties.clipsContent = true;
    scenes[1].children = [node("phone", "Phone"), group, node("logo", "Logo")];
  });
  try {
    const r = buildRegistry(f.project.inspection.document).objects.find(
        (o) => o.name === "QR",
      )!,
      a = resolveState(f.project.inspection.document, r, "s1"),
      b = resolveState(f.project.inspection.document, r, "s2");
    assert.deepEqual(a.layerPath, [1, 0]);
    assert.deepEqual(b.layerPath, [0]);
    assert.equal(a.hierarchy.at(-1)?.sourceNodeId, "group");
    assert.equal(a.transform[0][2], 160);
    assert.equal(a.hierarchy.at(-1)?.clipsContent, true);
    const p = statePresentation(f.project, f.state)[r.logicalObjectId];
    assert.deepEqual(
      interpolateState(p.s1, p.s2, f.transition, 18).matrix,
      p.s1.normalized,
    );
    assert.deepEqual(
      interpolateState(p.s1, p.s2, f.transition, 24).matrix,
      p.s2.normalized,
    );
    assert.ok(
      transitionDiagnostics(
        { ...f.state, objectTransitions: [f.transition] },
        f.project,
      ).some((w) => w.includes("clipping")),
    );
  } finally {
    await f.cleanup();
  }
});

test("overshoot and damped spring settle continuously with zero endpoint velocity", async () => {
  const f = await identityFixture();
  try {
    for (const easing of ["overshoot", "springSoft"] as const) {
      const t = {
        ...f.transition,
        easing,
        proceduralEffects: [
          {
            type: "dampedOscillation" as const,
            amplitude: 0.15,
            cycles: 2,
            damping: 3,
          },
        ],
      };
      assert.equal(transitionProgress(t, t.startFrame), 0);
      assert.equal(transitionProgress(t, 24), 1);
      const delta = 1e-4;
      assert.ok(Math.abs(transitionProgress(t, 24 - delta) - 1) < 1e-7);
      assert.ok(
        Array.from({ length: 101 }, (_, i) =>
          transitionProgress(t, 18 + i * 0.06),
        ).some((q) => q > 1),
      );
    }
  } finally {
    await f.cleanup();
  }
});

test("transition upsert, AI context/repair integration, undo/redo and immutable source", async () => {
  const f = await identityFixture();
  try {
    const before = fingerprint(await inventory(f.project.sourceRoot));
    const context = buildContext(f.project, f.state, "QR увеличивается");
    assert.equal(
      context.logicalObjects.find((o) => o.name === "QR")?.states.length,
      2,
    );
    const result = await runAutonomous(
      f.project,
      f.state,
      context,
      "QR плавно увеличивается",
      async () => ({
        status: "ready",
        summary: "QR",
        assumptions: [],
        warnings: [],
        operations: [operation(f.transition)],
      }),
    );
    let doc = (
      await changeMotion(f.project.root, {
        expectedRevision: "initial",
        request: "fixture",
        operations: [
          { type: "setProjectSettings", settings: f.state.settings },
          { type: "setBlocks", blocks: f.state.blocks },
          ...result.plan.operations,
        ],
      })
    ).document;
    const initial = structuredClone(doc.state);
    const edit = {
      ...f.transition,
      startFrame: 20,
      durationFrames: 4,
      easing: "overshoot" as const,
    };
    doc = (
      await changeMotion(f.project.root, {
        expectedRevision: doc.revision,
        request: "Добавь инерцию",
        operations: [operation(edit)],
      })
    ).document;
    assert.equal(doc.state.objectTransitions?.length, 1);
    assert.equal(doc.state.objectTransitions[0].transitionId, "qr-move");
    assert.equal(
      resolveTarget(f.project, doc.state, { request: "быстрее" }, []).target
        .targetId,
      "qr1",
    );
    doc = (
      await changeMotion(f.project.root, {
        expectedRevision: doc.revision,
        request: "undo",
        action: "undo",
      })
    ).document;
    assert.deepEqual(doc.state, initial);
    doc = (
      await changeMotion(f.project.root, {
        expectedRevision: doc.revision,
        request: "redo",
        action: "redo",
      })
    ).document;
    assert.equal(doc.state.objectTransitions![0].durationFrames, 4);
    assert.equal(fingerprint(await inventory(f.project.sourceRoot)), before);
  } finally {
    await f.cleanup();
  }
});

test("reimport refreshes references while IDs and motion history survive; renamed targets diagnose without rebinding", async () => {
  const f = await identityFixture();
  try {
    await changeMotion(f.project.root, {
      expectedRevision: "initial",
      request: "fixture",
      operations: [
        { type: "setProjectSettings", settings: f.state.settings },
        { type: "setBlocks", blocks: f.state.blocks },
        operation(f.transition),
      ],
    });
    const original = await readFile(
      path.join(f.project.root, "motion/motion.json"),
      "utf8",
    );
    const file = path.join(f.source, "scene.json"),
      source = JSON.parse(await readFile(file, "utf8"));
    source.scenes[1].children[0].figmaNodeId = "new-node";
    await writeFile(file, JSON.stringify(source));
    const update = () =>
      createProject({
        source: f.source,
        name: f.project.config.name,
        projectsRoot: path.dirname(f.project.root),
        projectPath: f.project.root,
        update: true,
      });
    await update();
    let project = await loadProject(f.project.root);
    let doc = await readMotion(project);
    assert.equal(
      doc.state.objectTransitions![0].logicalObjectId,
      logicalId("QR"),
    );
    assert.equal(
      doc.sourceDiagnostics?.some((d) => d.includes("исчез")),
      false,
    );
    const registry = JSON.parse(
      await readFile(
        path.join(project.root, "motion/object-registry.json"),
        "utf8",
      ),
    );
    assert.ok(
      registry.objects
        .find((o: { name: string }) => o.name === "QR")
        .states.some(
          (s: { sourceNodeId: string }) => s.sourceNodeId === "new-node",
        ),
    );
    assert.equal(
      await readFile(path.join(project.root, "motion/motion.json"), "utf8"),
      original,
    );
    source.scenes[2].children[0].name = "QUAN";
    await writeFile(file, JSON.stringify(source));
    await update();
    project = await loadProject(project.root);
    doc = await readMotion(project);
    assert.ok(doc.sourceDiagnostics?.some((d) => d.includes("отсутствует")));
    assert.equal(
      await readFile(path.join(project.root, "motion/motion.json"), "utf8"),
      original,
    );
  } finally {
    await f.cleanup();
  }
});

async function pixel(page: import("playwright").Page, x: number, y: number) {
  const png = await page.screenshot();
  return page.evaluate(
    async ({ src, x, y }) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const c = document.createElement("canvas");
      c.width = image.width;
      c.height = image.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      return Array.from(ctx.getImageData(x, y, 1, 1).data);
    },
    { src: "data:image/png;base64," + png.toString("base64"), x, y },
  );
}

test("browser single instance every frame, cut fallback through crossfade, hierarchy switch, masks and random seeking", async () => {
  const f = await identityFixture(3, (scenes) => {
    const logo = node("logo1", "Logo", 70, 20, 60, 60);
    logo.properties.fills = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }];
    scenes[1].children.push(logo);
    const logo2 = { ...structuredClone(logo), figmaNodeId: "logo2" };
    scenes[2].children.unshift(logo2);
  });
  const browser = await chromium.launch();
  try {
    f.state.blocks[1].durationFrames = 15;
    f.state.blocks[1].transition = { type: "crossfade", durationFrames: 3 };
    const t = {
      ...f.transition,
      durationFrames: 10,
      layerPolicy: { type: "switch" as const, switchProgress: 0.5 },
    };
    const state = applyOperations(f.state, [operation(t)], f.project),
      html = await motionHtml(f.project, state);
    assert.ok(html.warnings.some((w) => w.includes("crossfade")));
    const page = await browser.newPage({
      viewport: { width: 200, height: 120 },
    });
    await page.setContent(html.html);
    await page.evaluate(() => window.motionReady);
    for (const frame of [
      0, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 23, 18, 28, 0,
    ]) {
      await page.evaluate((f) => window.motionFrame(f), frame);
      const count = await page
        .locator('[data-motion-target="qr1"],[data-motion-target="qr2"]')
        .evaluateAll(
          (els) =>
            els.filter((el) => {
              let n: Element | null = el;
              while (n) {
                if (getComputedStyle(n).display === "none") return false;
                n = n.parentElement;
              }
              return true;
            }).length,
        );
      assert.equal(count, frame === 0 ? 0 : 1, `frame ${frame}`);
      if (frame === 28)
        assert.deepEqual(await pixel(page, 71, 21), [0, 0, 0, 255]);
    }
    // Static hierarchy baseline has QR below logo, target hierarchy has QR above logo.
    const staticPage = await browser.newPage({
      viewport: { width: 200, height: 120 },
    });
    await staticPage.setContent(await sceneThumbnailHtml(f.project, "s1"));
    assert.deepEqual(await pixel(staticPage, 71, 21), [255, 0, 0, 255]);
    await staticPage.setContent(await sceneThumbnailHtml(f.project, "s2"));
    assert.deepEqual(await pixel(staticPage, 71, 21), [0, 0, 0, 255]);
  } finally {
    await browser.close();
    await f.cleanup();
  }
});

test("nested clipping and parent opacity remain live, reparenting has exact world-space dimensions", async () => {
  const f = await identityFixture(3, (scenes) => {
    const qr = scenes[1].children[0];
    const group = node("group", "Group", 150, 70, 25, 25, [qr]);
    group.type = "FRAME";
    group.properties = {
      width: 25,
      height: 25,
      clipsContent: true,
      opacity: 0.5,
    };
    scenes[1].children = [group];
  });
  const browser = await chromium.launch();
  try {
    const state = applyOperations(
        f.state,
        [operation(f.transition)],
        f.project,
      ),
      page = await browser.newPage({ viewport: { width: 200, height: 120 } });
    await page.setContent((await motionHtml(f.project, state)).html);
    await page.evaluate(() => window.motionReady);
    await page.evaluate(() => window.motionFrame(18));
    const clipped = await pixel(page, 178, 81);
    assert.deepEqual(clipped, [0, 204, 51, 255]);
    const tinted = await pixel(page, 161, 81);
    assert.ok(tinted[1] > 80 && tinted[1] < 120);
    for (const frame of [18, 21, 24, 18, 24]) {
      await page.evaluate((f) => window.motionFrame(f), frame);
      const geometry = await page
        .locator("[data-logical-object]")
        .evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        });
      if (frame === 18)
        assert.deepEqual(geometry, { x: 160, y: 80, w: 20, h: 20 });
      if (frame === 24)
        assert.deepEqual(geometry, { x: 70, y: 20, w: 60, h: 60 });
    }
  } finally {
    await browser.close();
    await f.cleanup();
  }
});

test("preview and MP4 share transition compositing and decoded intermediate frame", async () => {
  const f = await identityFixture(),
    browser = await chromium.launch();
  try {
    const doc = (
      await changeMotion(f.project.root, {
        expectedRevision: "initial",
        request: "video fixture",
        operations: [
          { type: "setProjectSettings", settings: f.state.settings },
          { type: "setBlocks", blocks: f.state.blocks },
          operation(f.transition),
        ],
      })
    ).document;
    const page = await browser.newPage({
      viewport: { width: 200, height: 120 },
    });
    await page.setContent((await motionHtml(f.project, doc.state)).html);
    await page.evaluate(() => window.motionReady);
    await page.evaluate(() => window.motionFrame(21));
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
        "select='eq(n,21)'",
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
    assert.ok(difference < 3, `codec MAE ${difference}`);
  } finally {
    await browser.close();
    await f.cleanup();
  }
});

test("multiple objects retain independent parent paths; competing subtree ownership is rejected", async () => {
  const f = await identityFixture(3, (scenes) => {
    for (const i of [1, 2]) {
      const phone = node(`phone${i}`, "Phone", i === 1 ? 10 : 130, 50, 20, 30);
      const group = node(
        `group${i}`,
        "Product",
        i === 1 ? 5 : 120,
        40,
        40,
        50,
        [phone],
      );
      group.type = "GROUP";
      group.properties.fills = [];
      scenes[i].children.unshift(group);
    }
  });
  const browser = await chromium.launch();
  try {
    const phone = {
      ...f.transition,
      transitionId: "phone",
      logicalObjectId: logicalId("Phone"),
    };
    const state = applyOperations(
      f.state,
      [operation(f.transition), operation(phone)],
      f.project,
    );
    const page = await browser.newPage({
      viewport: { width: 200, height: 120 },
    });
    await page.setContent((await motionHtml(f.project, state)).html);
    await page.evaluate(() => window.motionReady);
    for (const frame of [18, 19, 20, 21, 22, 23, 24]) {
      await page.evaluate((f) => window.motionFrame(f), frame);
      assert.equal(await page.locator("[data-logical-object]").count(), 2);
      const qr = page.locator(`[data-logical-object="${logicalId("QR")}"]`);
      assert.equal(
        await qr.evaluate((el) =>
          el.closest("[data-motion-scene]")?.getAttribute("data-motion-scene"),
        ),
        frame === 24 ? "s2" : "s1",
      );
    }
    assert.throws(
      () =>
        applyOperations(
          state,
          [
            operation({
              ...phone,
              transitionId: "parent",
              logicalObjectId: logicalId("Product"),
            }),
          ],
          f.project,
        ),
      /родителя и потомка/,
    );
    assert.throws(
      () =>
        applyOperations(
          state,
          [operation({ ...phone, transitionId: "overlap" })],
          f.project,
        ),
      /Перекрывающиеся/,
    );
  } finally {
    await browser.close();
    await f.cleanup();
  }
});

test("Auto Layout reversed paint order keeps mask scopes and scene SVG IDs isolated", async () => {
  const f = await identityFixture(3, (scenes) => {
    for (const i of [1, 2]) {
      const mask = node(`mask${i}`, "Mask", 0, 0, i === 1 ? 80 : 160, 120);
      mask.properties.isMask = true;
      mask.properties.maskType = "VECTOR";
      const red = node(`red${i}`, "Red", 0, 0, 200, 120);
      red.properties.fills = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }];
      const blue = node(`blue${i}`, "Blue", 0, 0, 200, 120);
      blue.properties.fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 1 } }];
      scenes[i].children = [mask, red, blue];
      Object.assign(scenes[i].properties, { itemReverseZIndex: true });
    }
  });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 200, height: 120 },
    });
    await page.setContent((await motionHtml(f.project, f.state)).html);
    await page.evaluate(() => window.motionReady);
    await page.evaluate(() => window.motionFrame(12));
    assert.deepEqual(await pixel(page, 20, 20), [255, 0, 0, 255]);
    assert.deepEqual(await pixel(page, 100, 20), [0, 204, 51, 255]);
    await page.evaluate(() => window.motionFrame(24));
    assert.deepEqual(await pixel(page, 100, 20), [255, 0, 0, 255]);
    const ids = await page
      .locator("svg [id]")
      .evaluateAll((els) => els.map((e) => e.id));
    assert.equal(ids.length, new Set(ids).size);
  } finally {
    await browser.close();
    await f.cleanup();
  }
});
