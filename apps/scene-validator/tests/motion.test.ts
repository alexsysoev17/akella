import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { chromium } from "playwright";
import { createProject } from "../src/importer.js";
import { loadProject } from "../src/project.js";
import { inventory, fingerprint } from "../src/files.js";
import { defaultMotion, buildContext } from "../src/motion/context.js";
import { applyOperations, validateMotion } from "../src/motion/operations.js";
import { readMotion, changeMotion } from "../src/motion/store.js";
import { evaluateMotion } from "../src/motion/engine.js";
import { motionHtml } from "../src/motion/presentation.js";
import { exportVideo } from "../src/motion/video.js";
import { planSchema, type Animation } from "../src/motion/schema.js";
import { CodexProvider } from "../src/motion/provider.js";
import { servePlatform } from "../src/platform-server.js";
const identity = [
  [1, 0, 0],
  [0, 1, 0],
];
async function fixture(count = 1) {
  const root = await mkdtemp(path.join(os.tmpdir(), "director-test-"));
  const source = path.join(root, "export");
  await mkdir(source);
  await writeFile(
    path.join(source, "export-report.json"),
    JSON.stringify({ errorCount: 0 }),
  );
  await writeFile(
    path.join(source, "scene.json"),
    JSON.stringify({
      schemaVersion: "1.0.0",
      assets: [],
      scenes: Array.from({ length: count }, (_, i) => ({
        sceneId: `s${i}`,
        figmaNodeId: `r${i}`,
        name: `Scene ${i}`,
        index: i,
        width: 32,
        height: 24,
        type: "FRAME",
        sceneTransform: identity,
        properties: {
          width: 32,
          height: 24,
          clipsContent: true,
          fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }],
        },
        children: [
          {
            figmaNodeId: `text${i}`,
            parentId: `r${i}`,
            name: "Title",
            type: "RECTANGLE",
            sceneTransform: identity,
            properties: {
              width: 16,
              height: 16,
              fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 1 } }],
            },
            children: [],
          },
        ],
      })),
    }),
  );
  const imported = await createProject({
    name: "Fixture",
    source,
    projectsRoot: path.join(root, "projects"),
  });
  const project = await loadProject(imported.projectPath);
  return {
    root,
    project,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
const animation = (effect: "fadeIn" | "slideUp" = "fadeIn"): Animation =>
  ({
    animationId: effect,
    targetId: "text0",
    sceneId: "s0",
    effect,
    startFrame: 15,
    durationFrames: 18,
    easing: "easeOutCubic",
    enabled: true,
    parameters:
      effect === "fadeIn" ? { from: 0, to: 1 } : { distance: 20, mode: "in" },
  }) as Animation;
const objectValues = (state: ReturnType<typeof defaultMotion>, frame: number) =>
  evaluateMotion(state, frame).nodes[JSON.stringify(["s0", "text0"])];
for (const count of [1, 3, 15])
  test(`motion default supports ${count} scenes with independent stable blocks`, async () => {
    const f = await fixture(count);
    try {
      const state = validateMotion(defaultMotion(f.project), f.project);
      assert.equal(state.blocks.length, count);
      assert.equal(Object.keys(evaluateMotion(state, 0).blocks).length, 1);
      assert.equal(
        Object.keys(
          evaluateMotion(state, state.settings.durationFrames - 1).blocks,
        ).length,
        1,
      );
    } finally {
      await f.cleanup();
    }
  });
test("fade + slide deterministic seek, shift +15, easing and duration edits preserve other properties", async () => {
  const f = await fixture();
  try {
    const original = defaultMotion(f.project);
    let state = applyOperations(
      original,
      [
        { type: "addAnimation", animation: animation() },
        { type: "addAnimation", animation: animation("slideUp") },
      ],
      f.project,
    );
    assert.equal(original.animations.length, 0);
    assert.equal(objectValues(state, 0).opacity, 0);
    assert.equal(objectValues(state, 0).y, 20);
    assert.equal(objectValues(state, 33).opacity, 1);
    assert.equal(objectValues(state, 33).y, 0);
    const frame = evaluateMotion(state, 24);
    evaluateMotion(state, 90);
    assert.deepEqual(evaluateMotion(state, 24), frame);
    state = applyOperations(
      state,
      [
        { type: "shiftAnimation", animationId: "fadeIn", deltaFrames: 15 },
        { type: "shiftAnimation", animationId: "slideUp", deltaFrames: 15 },
      ],
      f.project,
    );
    assert.equal(state.animations[0].startFrame, 30);
    const before = structuredClone(state.animations[0]);
    state = applyOperations(
      state,
      [{ type: "setEasing", animationId: "fadeIn", easing: "springSoft" }],
      f.project,
    );
    assert.equal(state.animations[0].startFrame, before.startFrame);
    assert.equal(state.animations[0].durationFrames, before.durationFrames);
    state = applyOperations(
      state,
      [{ type: "setDuration", animationId: "fadeIn", durationFrames: 24 }],
      f.project,
    );
    assert.equal(state.animations[0].durationFrames, 24);
  } finally {
    await f.cleanup();
  }
});
test("unknown targets, conflicting properties, negative/outside timing and invalid AI JSON are rejected atomically", async () => {
  const f = await fixture();
  try {
    const state = defaultMotion(f.project);
    assert.throws(
      () =>
        applyOperations(
          state,
          [
            {
              type: "addAnimation",
              animation: { ...animation(), targetId: "missing" },
            },
          ],
          f.project,
        ),
      /Неизвестный/,
    );
    assert.throws(
      () =>
        applyOperations(
          state,
          [
            { type: "addAnimation", animation: animation() },
            {
              type: "addAnimation",
              animation: { ...animation(), animationId: "second" },
            },
          ],
          f.project,
        ),
      /Конфликт/,
    );
    assert.throws(() =>
      applyOperations(
        state,
        [
          {
            type: "addAnimation",
            animation: { ...animation(), startFrame: -1 },
          },
        ],
        f.project,
      ),
    );
    assert.throws(
      () =>
        applyOperations(
          state,
          [
            {
              type: "addAnimation",
              animation: { ...animation(), startFrame: 119 },
            },
          ],
          f.project,
        ),
      /длительность/,
    );
    assert.throws(() =>
      planSchema.parse({
        operations: [{ type: "executeJavaScript", code: "bad" }],
      }),
    );
    assert.throws(() => JSON.parse("not json"));
    assert.equal(state.animations.length, 0);
    assert.throws(() =>
      buildContext(f.project, state, "this", "missing", "s0"),
    );
  } finally {
    await f.cleanup();
  }
});
test("persistent undo/redo, reopen, stale revision, redo invalidation and source integrity", async () => {
  const f = await fixture();
  try {
    const before = fingerprint(await inventory(f.project.sourceRoot));
    let doc = await readMotion(f.project);
    doc = (
      await changeMotion(f.project.root, {
        expectedRevision: doc.revision,
        operations: [{ type: "addAnimation", animation: animation() }],
        request: "Create title",
        origin: "manual",
      })
    ).document;
    const rev = doc.revision;
    doc = (
      await changeMotion(f.project.root, {
        expectedRevision: rev,
        operations: [
          { type: "shiftAnimation", animationId: "fadeIn", deltaFrames: 15 },
        ],
        request: "Later",
      })
    ).document;
    assert.equal(
      (await readMotion(await loadProject(f.project.root))).state.animations[0]
        .startFrame,
      30,
    );
    await assert.rejects(
      changeMotion(f.project.root, {
        expectedRevision: rev,
        action: "undo",
        request: "undo",
      }),
      /изменилась/,
    );
    doc = (
      await changeMotion(f.project.root, {
        expectedRevision: doc.revision,
        action: "undo",
        request: "undo",
      })
    ).document;
    assert.equal(doc.state.animations[0].startFrame, 15);
    doc = (
      await changeMotion(f.project.root, {
        expectedRevision: doc.revision,
        action: "redo",
        request: "redo",
      })
    ).document;
    assert.equal(doc.state.animations[0].startFrame, 30);
    doc = (
      await changeMotion(f.project.root, {
        expectedRevision: doc.revision,
        action: "undo",
        request: "undo",
      })
    ).document;
    doc = (
      await changeMotion(f.project.root, {
        expectedRevision: doc.revision,
        operations: [
          { type: "setEasing", animationId: "fadeIn", easing: "linear" },
        ],
        request: "Manual",
      })
    ).document;
    await assert.rejects(
      changeMotion(f.project.root, {
        expectedRevision: doc.revision,
        action: "redo",
        request: "redo",
      }),
      /Нет изменений/,
    );
    assert.equal(fingerprint(await inventory(f.project.sourceRoot)), before);
  } finally {
    await f.cleanup();
  }
});
test("crossfade and sequential property tracks hold end values; unsupported trim rejects", async () => {
  const f = await fixture(3);
  try {
    const state = defaultMotion(f.project);
    state.blocks[0].durationFrames += 10;
    state.blocks[0].transition = { type: "crossfade", durationFrames: 10 };
    validateMotion(state, f.project);
    assert.equal(
      evaluateMotion(state, 65).blocks[state.blocks[1].blockId],
      0.5,
    );
    const entrance = animation();
    const exit = {
      ...animation(),
      animationId: "exit",
      effect: "fadeOut" as const,
      startFrame: 60,
      parameters: { from: 1, to: 0 },
    };
    const result = applyOperations(
      state,
      [
        { type: "addAnimation", animation: entrance },
        { type: "addAnimation", animation: exit },
      ],
      f.project,
    );
    assert.equal(objectValues(result, 40).opacity, 1);
    assert.equal(objectValues(result, 80).opacity, 0);
    assert.throws(
      () =>
        applyOperations(
          state,
          [
            {
              type: "addAnimation",
              animation: { ...animation(), effect: "trimPath" },
            },
          ],
          f.project,
        ),
      /Trim Path/,
    );
  } finally {
    await f.cleanup();
  }
});
test("provider failure propagates and never writes motion state", async () => {
  const f = await fixture();
  const previous = process.env.MOTION_CODEX_BIN;
  try {
    process.env.MOTION_CODEX_BIN = path.join(f.root, "missing-codex");
    const provider = new CodexProvider(
      { provider: "codex-sdk", model: "" },
      f.root,
    );
    await assert.rejects(provider.generateMotionPlan({}, "test"));
    assert.equal((await readMotion(f.project)).revision, "initial");
  } finally {
    if (previous === undefined) delete process.env.MOTION_CODEX_BIN;
    else process.env.MOTION_CODEX_BIN = previous;
    await f.cleanup();
  }
});
test("real MP4 has full frame count and decoded pixels agree with preview engine", async () => {
  const f = await fixture();
  let browser;
  try {
    const state = defaultMotion(f.project);
    state.settings = { ...state.settings, fps: 12, durationFrames: 24 };
    state.blocks[0].durationFrames = 24;
    const fade = { ...animation(), startFrame: 0, durationFrames: 12 };
    const doc = (
      await changeMotion(f.project.root, {
        expectedRevision: "initial",
        operations: [
          { type: "setProjectSettings", settings: state.settings },
          { type: "setBlocks", blocks: state.blocks },
          { type: "addAnimation", animation: fade },
        ],
        request: "Video fixture",
      })
    ).document;
    const html = await motionHtml(f.project, doc.state);
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 32, height: 24 } });
    await page.setContent(html.html);
    await page.evaluate(() => window.motionReady);
    await page.evaluate(() => window.motionFrame(12));
    const preview = await page.screenshot();
    const result = await exportVideo(f.project.root);
    assert.equal(result.frames, 24);
    const binary = createRequire(import.meta.url)("ffmpeg-static") as string;
    const video = path.join(f.project.root, "renders", result.file);
    const md5 = await promisify(execFile)(
      binary,
      ["-v", "error", "-i", video, "-f", "framemd5", "-"],
      { maxBuffer: 1000000 },
    );
    assert.equal(
      md5.stdout.split("\n").filter((l) => /^0,/.test(l)).length,
      24,
    );
    const decoded = await promisify(execFile)(
      binary,
      [
        "-v",
        "error",
        "-i",
        video,
        "-vf",
        "select='eq(n,12)'",
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
    const pixels = await page.evaluate(
      async (sources) =>
        Promise.all(
          sources.map(async (source) => {
            const i = new Image();
            i.src = source;
            await i.decode();
            const c = document.createElement("canvas");
            c.width = i.width;
            c.height = i.height;
            const x = c.getContext("2d")!;
            x.drawImage(i, 0, 0);
            return Array.from(x.getImageData(4, 4, 1, 1).data);
          }),
        ),
      [preview, decoded.stdout].map(
        (b) => "data:image/png;base64," + b.toString("base64"),
      ),
    );
    assert.ok(pixels[0].every((v, i) => Math.abs(v - pixels[1][i]) < 12));
  } finally {
    await browser?.close();
    await f.cleanup();
  }
});
test("browser Motion UI selects objects, applies manual operation, seeks and persists undo", async () => {
  const f = await fixture();
  const server = await servePlatform(path.join(f.root, "projects"), 0);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(
      `http://127.0.0.1:${(server.address() as { port: number }).port}/#project/${f.project.config.projectId}`,
    );
    await page.locator('#m-objects [data-target="text0"]').click();
    await changeMotion(f.project.root, {
      expectedRevision: "initial",
      operations: [{ type: "addAnimation", animation: animation() }],
      request: "Fixture animation",
    });
    await page.reload();
    await page.locator("#m-open-settings").waitFor();
    const timeline = await page.locator("#m-timeline").boundingBox();
    assert.ok(timeline);
    await page.mouse.move(
      timeline.x + timeline.width * 0.5,
      timeline.y + timeline.height / 2,
    );
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForFunction(
      () =>
        Number(
          document.querySelector("#m-timeline")?.getAttribute("aria-valuenow"),
        ) > 0,
    );
    assert.equal(await page.locator(".timeline-bar.peak").count(), 1);
    await page.locator("#m-timeline").focus();
    await page.keyboard.press("Home");
    assert.equal(
      await page.locator("#m-timeline").getAttribute("aria-valuenow"),
      "0",
    );

    assert.equal(
      await page.locator("nav,#validate,#m-add,#m-block-json").count(),
      0,
    );
    assert.equal((await readMotion(f.project)).state.animations.length, 1);
    await page.locator("#m-open-settings").click();
    await page.locator("#m-frame").fill("30");
    await page.locator("#m-close-settings").click();
    if (!(await page.locator("#m-settings-dialog").evaluate((el: HTMLDialogElement) => el.open))) await page.locator("#m-open-settings").click();
    await page.locator("#m-undo").click();
    await page.waitForFunction(() =>
      document.querySelector("#m-undo")?.hasAttribute("disabled"),
    );
    assert.equal((await readMotion(f.project)).state.animations.length, 0);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.cleanup();
  }
});

test("procedural effects, keyframes and stagger are deterministic and independently editable", async () => {
  const f = await fixture();
  try {
    const base = defaultMotion(f.project);
    const wave: Animation = {
      ...animation(),
      animationId: "wave",
      effect: "dampedOscillation",
      startFrame: 0,
      durationFrames: 60,
      easing: "linear",
      parameters: {
        property: "y",
        amplitude: 20,
        cycles: 2,
        phase: 0,
        damping: 4,
      },
    };
    let state = applyOperations(
      base,
      [
        { type: "addAnimation", animation: wave },
        { type: "addAnimation", animation: animation() },
      ],
      f.project,
    );
    assert.equal(objectValues(state, 0).y, 0);
    assert.ok(
      Math.abs(objectValues(state, 8).y!) >
        Math.abs(objectValues(state, 38).y!),
    );
    state = applyOperations(
      state,
      [
        {
          type: "setKeyframes",
          animationId: "wave",
          property: "x",
          points: [
            { frame: 0, value: 0 },
            { frame: 30, value: 100 },
            { frame: 60, value: 0 },
          ],
        },
      ],
      f.project,
    );
    assert.equal(objectValues(state, 15).x, 50);
    assert.equal(objectValues(state, 30).x, 100);
    state = applyOperations(
      state,
      [
        {
          type: "stagger",
          animationIds: ["wave", "fadeIn"],
          startFrame: 10,
          stepFrames: 5,
        },
      ],
      f.project,
    );
    assert.deepEqual(
      state.animations.map((a) => a.startFrame),
      [10, 15],
    );
    assert.throws(() =>
      applyOperations(
        state,
        [
          {
            type: "setKeyframes",
            animationId: "wave",
            property: "x",
            points: [
              { frame: 20, value: 0 },
              { frame: 10, value: 1 },
            ],
          },
        ],
        f.project,
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test("motion preview preserves dashed strokes without trim and restores them after removing trim", async () => {
  const f = await fixture();
  const browser = await chromium.launch();
  try {
    const state = defaultMotion(f.project);
    const html = await motionHtml(f.project, state);
    const page = await browser.newPage();
    await page.setContent(html.html);
    await page.evaluate(() => window.motionReady);
    const attributes = await page.evaluate((state) => {
      const node = document.querySelector('[data-motion-target="text0"]')!;
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("data-motion-trim", "true");
      p.setAttribute("d", "M0 0 L100 0");
      p.setAttribute("stroke", "black");
      p.setAttribute("stroke-dasharray", "4 2");
      node.append(p);
      window.motionUpdate(state);
      const initial = p.getAttribute("stroke-dasharray");
      state.animations = [
        {
          animationId: "trim",
          sceneId: "s0",
          targetId: "text0",
          effect: "trimPath",
          parameters: { from: 0, to: 1 },
          startFrame: 0,
          durationFrames: 30,
          easing: "linear",
          enabled: true,
        },
      ];
      window.motionUpdate(state);
      window.motionFrame(15);
      const animated = node
        .querySelector("[data-motion-reveal]")
        ?.getAttribute("stroke-dashoffset");
      state.animations = [];
      window.motionUpdate(state);
      return {
        initial,
        animated,
        restored: p.getAttribute("stroke-dasharray"),
        pathLength: p.getAttribute("pathLength"),
      };
    }, state);
    assert.deepEqual(attributes, {
      initial: "4 2",
      animated: "50",
      restored: "4 2",
      pathLength: null,
    });
  } finally {
    await browser.close();
    await f.cleanup();
  }
});

test("direct execution automatically commits manual JSON, preserves source and rejects stale/invalid plans", async () => {
  const { proposeMotion, manualResponse, completeExecution } = await import(
    "../src/motion/service.js"
  );
  const f = await fixture();
  try {
    const before = fingerprint(await inventory(f.project.sourceRoot));
    const request = {
      mode: "create",
      request: "Fade selected object",
      settings: { provider: "manual-response", model: "" },
      expectedRevision: "initial",
      selectedObjectId: "text0",
      selectedSceneId: "s0",
    };
    const pending = await proposeMotion(f.project, request);
    await manualResponse(f.project, pending.id, {
      summary: "Fade",
      questions: [],
      warnings: [],
      operations: [{ type: "addAnimation", animation: animation() }],
    });
    const applied = await completeExecution(f.project, pending.id);
    assert.equal(applied.status, "applied");
    assert.equal(applied.playbackStart, 15);
    assert.equal(applied.document.cursor, 1);
    await assert.rejects(
      completeExecution(f.project, pending.id),
      /изменилась/,
    );
    const follow = await proposeMotion(f.project, {
      ...request,
      request: "Later",
      expectedRevision: applied.document.revision,
      mode: "edit",
    });
    const context = JSON.parse(
      await readFile(
        path.join(f.project.root, "motion/ai", follow.id, "context.json"),
        "utf8",
      ),
    );
    assert.equal(
      context.recentConversation.at(-1).request,
      "Fade selected object",
    );
    assert.equal(context.appliedHistory.at(-1).request, "Fade selected object");
    await assert.rejects(
      manualResponse(f.project, follow.id, {
        summary: "Bad",
        questions: [],
        warnings: [],
        operations: [
          {
            type: "addAnimation",
            animation: {
              ...animation(),
              animationId: "other",
              targetId: "missing",
            },
          },
        ],
      }),
    );
    assert.deepEqual(
      (await readMotion(f.project)).state,
      applied.document.state,
    );
    await assert.rejects(
      manualResponse(f.project, follow.id, {
        summary: "Question",
        questions: ["Which object?"],
        warnings: [],
        operations: [],
      }),
      /вопросы запрещены/,
    );
    assert.equal(
      (await readMotion(f.project)).revision,
      applied.document.revision,
    );
    assert.equal(fingerprint(await inventory(f.project.sourceRoot)), before);
  } finally {
    await f.cleanup();
  }
});

test("Enter starts direct workflow; manual response auto-applies and autoplays without confirmation buttons", async () => {
  const f = await fixture();
  const server = await servePlatform(path.join(f.root, "projects"), 0);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(
      `http://127.0.0.1:${(server.address() as { port: number }).port}/#project/${f.project.config.projectId}`,
    );
    await page.locator('#m-objects [data-target="text0"]').click();
    assert.equal(await page.locator("#m-apply,#m-discard,#m-edit").count(), 0);
    await page.locator("#m-open-settings").click();
    await page.locator("#m-provider").selectOption("manual-response");
    await page.locator("#m-close-settings").click();
    await page.locator("#m-ai").fill("Fade");
    await page.locator("#m-ai").press("Enter");
    await page.locator("#m-manual").waitFor({ state: "visible" });
    await page.locator("#m-manual-response").fill(
      JSON.stringify({
        summary: "Manual fixture fade",
        questions: [],
        warnings: [],
        operations: [{ type: "addAnimation", animation: animation() }],
      }),
    );
    await page.locator("#m-read-response").click();
    await page.waitForFunction(
      () => document.querySelector("#m-play")?.textContent === "Пауза",
    );
    assert.equal(
      (await readMotion(f.project)).state.animations[0].startFrame,
      15,
    );
    await page.waitForFunction(
      () =>
        Number((document.querySelector("#m-frame") as HTMLInputElement).value) >
        15,
    );
    if (!(await page.locator("#m-settings-dialog").evaluate((el: HTMLDialogElement) => el.open))) await page.locator("#m-open-settings").click();
    await page.locator("#m-undo").click();
    await page.waitForFunction(() =>
      document.querySelector("#m-undo")?.hasAttribute("disabled"),
    );
    assert.equal((await readMotion(f.project)).state.animations.length, 0);
    await page.locator("#m-redo").click();
    await page.waitForFunction(() =>
      document.querySelector("#m-redo")?.hasAttribute("disabled"),
    );
    assert.equal((await readMotion(f.project)).state.animations.length, 1);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.cleanup();
  }
});

test("autonomous runtime repairs questions and invalid easing, applies only validated operations, and bounds attempts", async () => {
  const { runAutonomous, MAX_AGENT_ATTEMPTS } = await import(
    "../src/motion/autonomy.js"
  );
  const f = await fixture();
  try {
    const base = defaultMotion(f.project);
    const errors: unknown[] = [];
    let calls = 0;
    const result = await runAutonomous(
      f.project,
      base,
      {},
      "Animate",
      async (ctx) => {
        calls++;
        if (calls === 1)
          return {
            summary: "Which?",
            questions: ["Which text?"],
            warnings: [],
            operations: [],
          };
        assert.ok((ctx as { runtimeFeedback: unknown }).runtimeFeedback);
        if (calls === 2)
          return {
            summary: "Animate",
            status: "ready",
            assumptions: [],
            warnings: [],
            operations: [
              {
                type: "addAnimation",
                animation: { ...animation(), easing: "unsupported-easing" },
              },
            ],
          };
        return {
          summary: "Animated",
          status: "ready",
          assumptions: ["Duration chosen autonomously"],
          warnings: [],
          operations: [{ type: "addAnimation", animation: animation() }],
        };
      },
      async (entry) => {
        errors.push(entry);
      },
    );
    assert.equal(calls, MAX_AGENT_ATTEMPTS);
    assert.equal(result.next.animations.length, 1);
    assert.equal(base.animations.length, 0);
    assert.equal((await readMotion(f.project)).revision, "initial");
    assert.equal(errors.length, 3);
    let attempts = 0;
    await assert.rejects(
      runAutonomous(f.project, base, {}, "impossible", async () => {
        attempts++;
        return {
          status: "unsupported",
          summary: "Unsupported geometry",
          assumptions: [],
          warnings: [],
          operations: [],
        };
      }),
      /после 3 попыток/,
    );
    assert.equal(attempts, 3);
    assert.equal((await readMotion(f.project)).revision, "initial");
  } finally {
    await f.cleanup();
  }
});

test("autonomous target resolution uses selected, named, active scene and history; ambiguous choices are recorded", async () => {
  const { resolveTarget } = await import("../src/motion/autonomy.js");
  const f = await fixture(3);
  try {
    const state = defaultMotion(f.project);
    assert.equal(
      resolveTarget(
        f.project,
        state,
        { request: "text2", selectedObjectId: "text0", selectedSceneId: "s0" },
        [],
      ).target.targetId,
      "text0",
    );
    assert.equal(
      resolveTarget(f.project, state, { request: "text2" }, []).target.targetId,
      "text2",
    );
    const active = resolveTarget(
      f.project,
      state,
      { request: "Этот текст динамичнее", activeSceneId: "s1" },
      [],
    );
    assert.equal(active.target.targetId, "text1");
    assert.ok(active.assumptions.length);
    assert.equal(
      resolveTarget(f.project, state, { request: "Медленнее" }, [
        { selectedObjectId: "text2", selectedSceneId: "s2" },
      ]).target.targetId,
      "text2",
    );
    const duplicate = resolveTarget(
      f.project,
      state,
      { request: "Title", activeSceneId: "s2" },
      [],
    );
    assert.equal(duplicate.target.targetId, "text2");
    assert.ok(duplicate.assumptions.length);
  } finally {
    await f.cleanup();
  }
});
