import test from "node:test";
import assert from "node:assert/strict";
import { identityFixture, node } from "./identity-fixture.js";
import { objectRequirement } from "./intent-fixture.js";
import { validateIntentPlan } from "../src/motion/intent/planner.js";
import {
  compileTasks,
  compileRequirement,
} from "../src/motion/intent/compiler.js";
import { applyOperations } from "../src/motion/operations.js";
import { readMotion } from "../src/motion/store.js";
import { logicalId } from "../src/motion/registry.js";
import { motionHtml } from "../src/motion/presentation.js";
import { chromium } from "playwright";

test("scene-center motion reaches scene center through rotated scaled parent in actual renderer", async () => {
  const f = await identityFixture(1, (scenes) => {
    const child = node("child", "Nested", 80, 70, 20, 10);
    child.sceneTransform = [
      [0, -2, 80],
      [3, 0, 70],
    ];
    const parent = node("parent", "Container", 100, 40, 100, 100, [child]);
    parent.type = "GROUP";
    parent.sceneTransform = [
      [0, -2, 100],
      [3, 0, 40],
    ];
    scenes[0].children = [parent];
  });
  const browser = await chromium.launch();
  try {
    const state = (await readMotion(f.project)).state;
    const req = objectRequirement(
      "center",
      "s0",
      "child",
      "Nested",
      ["moveTo"],
      "Move Nested to center",
    );
    req.target.logicalObjectId = logicalId("Nested");
    req.parameters.moveToCenter = true;
    req.parameters.durationSeconds = 0.5;
    const plan = validateIntentPlan(f.project, req.sourceText, {
      schemaVersion: "1.0.0",
      requirements: [req],
      coverage: [
        {
          sourceText: req.sourceText,
          requirementIds: ["center"],
          classification: "executable",
          explanation: "fixture",
        },
      ],
      assumptions: [],
    });
    const op = compileRequirement(
      f.project,
      state,
      plan,
      compileTasks(f.project, plan)[0],
    );
    const after = applyOperations(state, op.operations, f.project);
    const page = await browser.newPage({
      viewport: { width: state.settings.width, height: state.settings.height },
    });
    await page.setContent((await motionHtml(f.project, after)).html);
    await page.evaluate(() => window.motionReady);
    await page.evaluate(() => window.motionFrame(30));
    const center = await page
      .locator('[data-motion-target="child"]')
      .evaluate((el) => {
        const rect = el.querySelector("rect")!;
        const r = rect.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
    assert.ok(
      Math.abs(center.x - state.settings.width / 2) < 0.01,
      JSON.stringify(center),
    );
    assert.ok(
      Math.abs(center.y - state.settings.height / 2) < 0.01,
      JSON.stringify(center),
    );
  } finally {
    await browser.close();
    await f.cleanup();
  }
});

test("before dependency duration edit preserves endpoint-attached inertia and is idempotent", async () => {
  const f = await identityFixture(1, (scenes) => {
    scenes[0].children = [node("box", "Box")];
  });
  try {
    let s = (await readMotion(f.project)).state;
    const target = "box";
    s = applyOperations(
      s,
      [
        {
          type: "addAnimation",
          animation: {
            animationId: "anchor",
            targetId: target,
            sceneId: "s0",
            effect: "fadeIn",
            parameters: { from: 0, to: 1 },
            startFrame: 30,
            durationFrames: 10,
            easing: "linear",
            enabled: true,
          },
        },
        {
          type: "addAnimation",
          animation: {
            animationId: "base",
            targetId: target,
            sceneId: "s0",
            effect: "slideUp",
            parameters: { distance: 30, mode: "in" },
            startFrame: 20,
            durationFrames: 10,
            easing: "linear",
            enabled: true,
          },
        },
        {
          type: "setExpression",
          expression: {
            expressionId: "inertia",
            type: "inertialOvershoot",
            targetId: target,
            sceneId: "s0",
            sourceAnimationId: "base",
            property: "y",
            startFrame: 30,
            durationFrames: 15,
            enabled: true,
            parameters: {
              mode: "ae",
              amplitude: 0.1,
              frequency: 2,
              decay: 3,
              velocityLookbackFrames: 1,
            },
          },
        },
        {
          type: "setTimingDependency",
          dependency: {
            dependencyId: "order",
            animationId: "base",
            anchorAnimationId: "anchor",
            relation: "before",
            offsetFrames: 0,
          },
        },
      ],
      f.project,
    );
    const next = applyOperations(
      s,
      [{ type: "setDuration", animationId: "base", durationFrames: 20 }],
      f.project,
    );
    assert.equal(
      next.animations.find((a) => a.animationId === "base")!.startFrame,
      10,
    );
    assert.equal(next.expressions![0].startFrame, 30);
    assert.deepEqual(
      applyOperations(
        next,
        [
          {
            type: "setTimingDependency",
            dependency: {
              dependencyId: "order",
              animationId: "base",
              anchorAnimationId: "anchor",
              relation: "before",
              offsetFrames: 0,
            },
          },
        ],
        f.project,
      ),
      next,
    );
  } finally {
    await f.cleanup();
  }
});

import { fork } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { lockProject, atomicJson } from "../src/files.js";
import { changeMotion } from "../src/motion/store.js";
import { parentLocalDelta, type Matrix } from "../src/motion/geometry.js";
import { qaAdmission } from "../src/motion/qa/policy.js";
import { readRuns, recoverInterruptedRuns } from "../src/harness/runtime.js";
import { hostname } from "node:os";
async function killedWorker(mode: string, root: string, id = "") {
  const c = fork(
    new URL("./fixtures/recovery-worker.ts", import.meta.url),
    [mode, root, id],
    {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  const [message] = await Promise.race([
    once(c, "message"),
    once(c, "exit").then(([code]) => {
      throw Error("worker exited " + code);
    }),
  ]);
  c.kill("SIGKILL");
  await once(c, "exit");
  return { message, pid: c.pid };
}
test("real SIGKILL leaves owner lock recoverable; live ownership is never stolen", async () => {
  const f = await identityFixture(1);
  try {
    assert.equal(
      (await killedWorker("lock", f.project.root)).message,
      "LOCKED",
    );
    const unlock = await lockProject(f.project.root);
    await assert.rejects(lockProject(f.project.root), /PROJECT_BUSY/);
    await unlock();
    const again = await lockProject(f.project.root);
    await again();
    assert.ok(
      (await readdir(f.project.root)).some((n) =>
        n.startsWith(".project-lock-recovered-"),
      ),
    );
    await mkdir(f.project.root + "/.project-lock");
    await assert.rejects(lockProject(f.project.root), /OWNER_UNKNOWN/);
  } finally {
    await f.cleanup();
  }
});
test("committed receipt survives process death; transaction replay is idempotent and undo/redo exact", async () => {
  const f = await identityFixture(1);
  try {
    const before = await readMotion(f.project),
      id = randomUUID();
    const killed = await killedWorker("commit", f.project.root, id);
    assert.equal(killed.message, "COMMITTED");
    const runDir = f.project.root + "/motion/harness/runs/" + id;
    await mkdir(runDir, { recursive: true });
    await atomicJson(runDir + "/run.json", {
      runId: id,
      status: "RUNNING",
      ownerPid: killed.pid,
      ownerHost: hostname(),
    });
    await recoverInterruptedRuns(f.project.root);
    const recovered = (await readRuns(f.project.root))[0];
    assert.equal(recovered.status, "INTERRUPTED");
    assert.equal(
      (recovered.recovery as { commit: string }).commit,
      "CONFIRMED",
    );
    const corrupt = f.project.root + "/motion/harness/runs/" + randomUUID();
    await mkdir(corrupt);
    await writeFile(corrupt + "/run.json", "{truncated");
    assert.ok(
      (await readRuns(f.project.root)).some(
        (r) => r.status === "CORRUPT_DIAGNOSTIC",
      ),
    );
    const current = await readMotion(f.project);
    assert.equal(current.lastCommit?.transactionId, id);
    assert.equal(current.state.settings.fps, 24);
    const replay = await changeMotion(f.project.root, {
      expectedRevision: before.revision,
      transactionId: id,
      operations: [
        {
          type: "setProjectSettings",
          settings: { ...before.state.settings, fps: 24 },
        },
      ],
      request: "retry",
      origin: "manual",
    });
    assert.equal(replay.document.revision, current.revision);
    assert.equal(replay.document.history.length, 1);
    const undone = await changeMotion(f.project.root, {
      expectedRevision: current.revision,
      action: "undo",
      request: "undo",
    });
    assert.deepEqual(undone.document.state, before.state);
    const redone = await changeMotion(f.project.root, {
      expectedRevision: undone.document.revision,
      action: "redo",
      request: "redo",
    });
    assert.deepEqual(redone.document.state, current.state);
    await assert.rejects(
      changeMotion(f.project.root, {
        expectedRevision: before.revision,
        operations: [{ type: "setProjectDuration", durationFrames: 100 }],
        request: "stale",
      }),
      /изменилась/,
    );
  } finally {
    await f.cleanup();
  }
});
test("SIGKILL at publication entry never leaves partial JSON", async () => {
  const f = await identityFixture(1);
  try {
    const file = f.root + "/atomic.json";
    await atomicJson(file, { generation: -1, payload: "before" });
    await killedWorker("write", file);
    const d = JSON.parse(await readFile(file, "utf8"));
    assert.ok(d.generation >= -1);
    assert.equal(
      d.payload,
      d.generation === -1 ? "before" : "x".repeat(5000000),
    );
  } finally {
    await f.cleanup();
  }
});
test("candidate mismatch and invalid batches cannot publish earlier successful operations", async () => {
  const f = await identityFixture(1);
  try {
    const before = await readMotion(f.project);
    await assert.rejects(
      changeMotion(f.project.root, {
        expectedRevision: before.revision,
        operationBatches: [
          [
            {
              type: "setProjectSettings",
              settings: { ...before.state.settings, fps: 24 },
            },
          ],
          [{ type: "removeAnimation", animationId: "missing" }],
        ],
        request: "bad batch",
      }),
    );
    assert.deepEqual(await readMotion(f.project), before);
    await assert.rejects(
      changeMotion(f.project.root, {
        expectedRevision: before.revision,
        operations: [
          {
            type: "setProjectSettings",
            settings: { ...before.state.settings, fps: 24 },
          },
        ],
        expectedCandidate: before.state,
        request: "mismatch",
      }),
      /CANDIDATE_COMMIT_MISMATCH/,
    );
    assert.deepEqual(await readMotion(f.project), before);
  } finally {
    await f.cleanup();
  }
});
test("QA admission does not accept a contradictory PASSED or unverified required render; art absence is not a blocker", () => {
  assert.equal(
    qaAdmission({
      status: "PASSED",
      checks: [{ name: "geometry", status: "FAILED" }],
    }).accepted,
    false,
  );
  for (const status of ["WARNING", "NOT_TESTED"])
    assert.equal(
      qaAdmission({
        status: "WARNING",
        checks: [
          { name: "visibility", category: "render", required: true, status },
        ],
      }).accepted,
      false,
    );
  assert.equal(
    qaAdmission({
      status: "PASSED",
      checks: [
        { name: "renderedFrames", category: "render", status: "PASSED" },
        { name: "art", category: "artistic", status: "NOT_TESTED" },
      ],
    }).accepted,
    true,
  );
  assert.equal(
    qaAdmission({ status: "PASSED", checks: [] }).renderValidation,
    "NOT_TESTED",
  );
});
test("seeded affine displacement invariants: rotation/reflection/nonuniform scale preserve scene vector", () => {
  let seed = 72;
  const rnd = () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 200; i++) {
    const a = rnd() * Math.PI * 2,
      sx = (0.1 + rnd() * 4) * (i % 2 ? 1 : -1),
      sy = 0.1 + rnd() * 3,
      c = Math.cos(a),
      s = Math.sin(a);
    const m: Matrix = [
      [c * sx, -s * sy, rnd() * 500],
      [s * sx, c * sy, rnd() * 500],
    ];
    const x = rnd() * 300 - 150,
      y = rnd() * 300 - 150,
      v = parentLocalDelta(m, x, y);
    assert.ok(Math.abs(m[0][0] * v.x + m[0][1] * v.y - x) < 1e-9);
    assert.ok(Math.abs(m[1][0] * v.x + m[1][1] * v.y - y) < 1e-9);
  }
  assert.throws(() =>
    parentLocalDelta(
      [
        [0, 0, 0],
        [0, 1, 0],
      ],
      1,
      1,
    ),
  );
});

import { motionQA } from "../src/motion/qa/render.js";
test("real rendered invisible Trim Paths cannot pass required reveal admission", async () => {
  const f = await identityFixture(1, (scenes) => {
    const n = node("line", "Line", 1000, 1000, 100, 10);
    n.type = "VECTOR";
    n.properties = {
      width: 100,
      height: 10,
      fills: [],
      strokeWeight: 4,
      strokeAlign: "CENTER",
      strokes: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }],
      vectorPaths: [{ data: "M0 0 L100 0", windingRule: "NONZERO" }],
    };
    scenes[0].children = [n];
  });
  try {
    const before = (await readMotion(f.project)).state;
    const after = applyOperations(
      before,
      [
        {
          type: "addAnimation",
          animation: {
            animationId: "reveal",
            sceneId: "s0",
            targetId: "line",
            effect: "trimPath",
            parameters: { from: 0, to: 1, direction: "forward" },
            startFrame: 0,
            durationFrames: 10,
            easing: "linear",
            enabled: true,
          },
        },
      ],
      f.project,
    );
    const qa = await motionQA(
      f.project,
      after,
      "motion/qa/invisible",
      "Trim Paths",
      before,
    );
    assert.equal(qa.status, "FAILED");
    assert.ok(
      qa.checks.some(
        (c) =>
          c.name === "renderedPathReveal" &&
          c.required &&
          c.status !== "PASSED",
      ),
    );
    assert.equal(qaAdmission(qa).accepted, false);
  } finally {
    await f.cleanup();
  }
});
