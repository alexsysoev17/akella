import test from "node:test";
import assert from "node:assert/strict";
import { identityFixture, node } from "./identity-fixture.js";
import { planMotionTasks, assertTaskScope } from "../src/motion/tasks.js";
import { runMotionTasks } from "../src/motion/task-runner.js";
import {
  intentRequirements,
  validateTechnique,
} from "../src/motion/qa/technical.js";
import { readMotion, changeMotion } from "../src/motion/store.js";
import type { MotionTask } from "../src/motion/tasks.js";
import type { Plan, Animation } from "../src/motion/schema.js";
const prompt =
  "Пусть Лента 1 и Лента 2 анимируются через Trim Paths. Добавь сильные затухающие колебания после Position movement для Image, QR, Text и Logo.";
async function fixture() {
  return identityFixture(2, (scenes) => {
    scenes[0].children = ["Image", "QR", "Text", "Logo"].map((n, i) =>
      node("obj" + i, n),
    );
    scenes[1].children = ["Лента 1", "Лента 2"].map((n, i) => {
      const v = node("ribbon" + i, n);
      v.type = "VECTOR";
      v.properties = {
        ...v.properties,
        fills: [],
        strokes: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }],
        strokeWeight: 2,
        strokeAlign: "CENTER",
        vectorPaths: [{ data: "M0 0 L20 20", windingRule: "NONZERO" }],
      };
      return v;
    });
  });
}
function operations(t: MotionTask): Plan {
  const base: Animation = {
    animationId: "move-" + t.taskId,
    sceneId: t.targetReference.sceneId,
    targetId: t.targetReference.targetId,
    startFrame: t.techniqueId === "trimPath" ? 60 : 0,
    durationFrames: 12,
    easing: "linear",
    enabled: true,
    effect: "property",
    parameters: { property: "x", from: -20, to: 0 },
  };
  return {
    status: "ready",
    summary: "test provider",
    warnings: [],
    assumptions: [],
    operations:
      t.techniqueId === "trimPath"
        ? [
            {
              type: "addAnimation",
              animation: {
                ...base,
                effect: "trimPath",
                parameters: { from: 0, to: 1, direction: "forward" },
              },
            },
          ]
        : [
            { type: "addAnimation", animation: base },
            {
              type: "setExpression",
              expression: {
                expressionId: "inertia-" + t.taskId,
                sceneId: base.sceneId,
                targetId: base.targetId,
                type: "inertialOvershoot",
                property: "x",
                sourceAnimationId: base.animationId,
                startFrame: 12,
                durationFrames: 30,
                enabled: true,
                parameters: {
                  amplitude: 0.5,
                  frequency: 2,
                  decay: 3,
                  velocityLookbackFrames: 6,
                },
              },
            },
          ],
  };
}
test("EVAL_MULTIPLE_TECHNIQUES_DIFFERENT_TARGETS: six explicit pairs, mentions do not hide ribbons", async () => {
  const f = await fixture();
  try {
    const context = {
      activeSceneId: "s0",
      mentions: ["obj0", "obj1", "obj2", "obj3"].map((sourceNodeId) => ({
        sourceNodeId,
        sceneId: "s0",
      })),
    };
    for (const text of [
      prompt,
      "пусть лента 1 и лента 2 анимируется через trim paths повторяю и будут сильные затухающие колебания после position у объектов Image QR Text Logo",
    ]) {
      const tasks = planMotionTasks(f.project, f.state, text, context);
      assert.equal(tasks.length, 6);
      assert.deepEqual(
        tasks
          .filter((t) => t.techniqueId === "trimPath")
          .map((t) => t.targetReference.targetId),
        ["ribbon0", "ribbon1"],
      );
      assert.equal(
        tasks.filter((t) => t.techniqueId === "inertialOvershoot").length,
        4,
      );
      assert.ok(
        tasks.every(
          (t) => t.status === "PENDING" && t.targetReference.logicalObjectId,
        ),
      );
      const req = intentRequirements(f.project, f.state, text, context);
      assert.equal(req.length, 6);
      assert.ok(req.every((r) => r.targets.length === 1 && r.taskId));
    }
  } finally {
    await f.cleanup();
  }
});
test("task commits survive independent failure; repair only failed target; persisted history per task", async () => {
  const f = await fixture();
  try {
    const initial = await readMotion(f.project);
    let doc = initial;
    const calls = new Map<string, number>();
    const result = await runMotionTasks(
      f.project,
      doc.state,
      { activeSceneId: "s0" },
      prompt,
      {
        call: async (t, ctx) => {
          const n = (calls.get(t.taskId) ?? 0) + 1;
          calls.set(t.taskId, n);
          if (t.targetReference.targetId === "ribbon1")
            throw new Error("fixture technical failure");
          if (t.targetReference.targetId === "obj1" && n === 1)
            return operations({ ...t, techniqueId: "trimPath" });
          if (n > 1)
            assert.ok((ctx as { runtimeFeedback: unknown }).runtimeFeedback);
          return operations(t);
        },
        verify: async () => ({ status: "PASSED", fixture: true }),
        commit: async (t, p) => {
          doc = (
            await changeMotion(f.project.root, {
              expectedRevision: doc.revision,
              operations: p.operations,
              request: t.taskId,
            })
          ).document;
        },
        trace: async () => {},
      },
    );
    assert.equal(result.reconciliation.status, "PARTIAL_SUCCESS");
    assert.equal(
      result.reconciliation.completed,
      5,
      JSON.stringify(result.tasks.map((t) => t.error)),
    );
    assert.equal(doc.history.length, 5);
    assert.equal((await readMotion(f.project)).revision, doc.revision);
    assert.equal(
      calls.get(
        result.tasks.find((t) => t.targetReference.targetId === "ribbon0")!
          .taskId,
      ),
      1,
    );
    assert.equal(
      calls.get(
        result.tasks.find((t) => t.targetReference.targetId === "ribbon1")!
          .taskId,
      ),
      3,
    );
    assert.equal(
      calls.get(
        result.tasks.find((t) => t.targetReference.targetId === "obj1")!.taskId,
      ),
      2,
    );
    assert.equal(doc.state.expressions?.length, 4);
  } finally {
    await f.cleanup();
  }
});
test("preflight blocks missing geometry without provider calls; same object techniques have dependencies; repeat edit scope", async () => {
  const f = await fixture();
  try {
    const tasks = planMotionTasks(
      f.project,
      f.state,
      "Лента 1 trim paths и инерционные колебания после position",
      { activeSceneId: "s1" },
    );
    assert.equal(tasks.length, 2);
    assert.deepEqual(tasks[1].dependencies, [tasks[0].taskId]);
    const missing = planMotionTasks(f.project, f.state, "QR trim paths", {
      activeSceneId: "s0",
    });
    assert.equal(missing[0].status, "BLOCKED");
    let calls = 0;
    await runMotionTasks(
      f.project,
      f.state,
      { activeSceneId: "s0" },
      "QR trim paths",
      {
        call: async () => {
          calls++;
          return {};
        },
        verify: async () => ({}),
        commit: async () => {},
        trace: async () => {},
      },
    );
    assert.equal(calls, 0);
    const current = structuredClone(f.state);
    current.animations = [
      {
        animationId: "other",
        targetId: "obj0",
        sceneId: "s0",
        effect: "fadeIn",
        parameters: { from: 0, to: 1 },
        startFrame: 0,
        durationFrames: 6,
        easing: "linear",
        enabled: true,
      },
    ];
    const changed = structuredClone(current);
    changed.animations = [];
    assert.throws(
      () => assertTaskScope(current, changed, tasks[0]),
      /TASK_SCOPE/,
    );
  } finally {
    await f.cleanup();
  }
});
test("same name in multiple scenes resolves active scene or blocks ambiguity", async () => {
  const f = await identityFixture(3);
  try {
    const scoped = planMotionTasks(
      f.project,
      f.state,
      "QR инерционные колебания после position",
      { activeSceneId: "s2" },
    );
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].targetReference.targetId, "qr2");
    const ambiguous = planMotionTasks(
      f.project,
      f.state,
      "QR инерционные колебания после position",
      {},
    );
    assert.ok(ambiguous.every((t) => t.status === "BLOCKED"));
  } finally {
    await f.cleanup();
  }
});

test("unpunctuated technique switch binds separately; IDs and logical IDs resolve exact objects", async () => {
  const f = await fixture();
  try {
    const tasks = planMotionTasks(
      f.project,
      f.state,
      "Лента 1 trim paths, QR inertial overshoot",
      { activeSceneId: "s0" },
    );
    assert.equal(tasks.length, 2);
    assert.deepEqual(
      tasks.map((t) => [t.targetReference.targetId, t.techniqueId]),
      [
        ["ribbon0", "trimPath"],
        ["obj1", "inertialOvershoot"],
      ],
    );
    for (const id of ["ribbon0", tasks[0].targetReference.logicalObjectId!]) {
      const resolved = planMotionTasks(
        f.project,
        f.state,
        `${id} trim paths`,
        {},
      );
      assert.equal(resolved.length, 1);
      assert.equal(resolved[0].targetReference.targetId, "ribbon0");
    }
  } finally {
    await f.cleanup();
  }
});
test("follow-up changes inertia only; task scope rejects altering previous base track and unrelated expression", async () => {
  const f = await fixture();
  try {
    const { applyOperations } = await import("../src/motion/operations.js");
    const state = (await readMotion(f.project)).state;
    const initialTask = planMotionTasks(
      f.project,
      state,
      "QR инерционные колебания после движения",
      { activeSceneId: "s0" },
    )[0];
    const before = applyOperations(
      state,
      operations(initialTask).operations,
      f.project,
    );
    const task = planMotionTasks(
      f.project,
      before,
      "QR колебания в два раза слабее",
      { activeSceneId: "s0" },
    )[0];
    const after = structuredClone(before);
    after.expressions![0].parameters.amplitude *= 0.5;
    assert.doesNotThrow(() => assertTaskScope(before, after, task));
    after.animations[0].durationFrames += 1;
    assert.throws(() => assertTaskScope(before, after, task), /TASK_SCOPE/);
  } finally {
    await f.cleanup();
  }
});
test("dependent failure blocks only dependent technique; QA failure is recorded and repaired per task", async () => {
  const f = await fixture();
  try {
    const state = (await readMotion(f.project)).state;
    let calls = 0,
      commits = 0;
    const result = await runMotionTasks(
      f.project,
      state,
      { activeSceneId: "s1" },
      "Лента 1 trim paths и инерционные колебания после position",
      {
        call: async (t) => {
          calls++;
          return operations(t);
        },
        verify: async () => ({
          status: "FAILED",
          checks: [{ name: "pixels", status: "FAILED" }],
        }),
        commit: async () => {
          commits++;
        },
        trace: async (tasks) => {
          assert.doesNotThrow(() => JSON.stringify(tasks));
        },
      },
    );
    assert.equal(calls, 3);
    assert.equal(commits, 0);
    assert.equal(result.tasks[0].status, "FAILED");
    assert.equal(result.tasks[1].status, "BLOCKED");
    assert.equal(
      (result.tasks[0].qaResult as { status: string }).status,
      "FAILED",
    );
  } finally {
    await f.cleanup();
  }
});

test('browser shows partial task result through autoplay and does not autoplay a wholly failed run', async () => {
  const { chromium } = await import('playwright');
  const { servePlatform } = await import('../src/platform-server.js');
  const path = await import('node:path');
  const f = await fixture();
  const server = await servePlatform(path.join(f.root, 'projects'), 0);
  const browser = await chromium.launch();
  try {
    const motionDocument = await readMotion(f.project);
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    let completed = 5;
    await page.route('**/motion/execute', route => route.fulfill({json:{jobId:'fixture-job'}}));
    await page.route('**/motion/jobs/fixture-job', route => route.fulfill({json:{status:'completed', result:{
      document:motionDocument,playbackStart:0,
      plan:{summary:'Fixture task result',assumptions:[],warnings:[]},
      reconciliation:{requested:6,completed,status:completed?'PARTIAL_SUCCESS':'FAILED'},
      tasks:[{targetReference:{name:'Лента 2'},status:'FAILED',error:'Fixture missing geometry'}],
    }}}));
    await page.goto(`http://127.0.0.1:${(server.address() as {port:number}).port}/#project/${f.project.config.projectId}`);
    await page.locator('#m-ai').fill('Fixture request');
    await page.locator('#m-generate').click();
    await page.waitForFunction(() => Number((document.querySelector('#m-frame') as HTMLInputElement)?.value)>0);
    assert.match(await page.locator('#m-job').innerText(),/Выполнено частично: 5 из 6/);
    assert.match(await page.locator('#m-error').innerText(),/Лента 2.*Fixture missing geometry/);
    completed=0;
    await page.locator('#m-generate').click();
    await page.waitForFunction(() => document.querySelector('#m-job')?.textContent?.includes('Не выполнено: 0 из 6'));
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(await page.locator('#m-frame').inputValue(),'0');
    assert.deepEqual(errors,[]);
  } finally {
    await browser.close();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await f.cleanup();
  }
});
