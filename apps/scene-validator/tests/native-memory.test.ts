import test, { after } from "node:test";
import assert from "node:assert/strict";
import { identityFixture, node } from "./identity-fixture.js";
import { intentFixture, objectRequirement } from "./intent-fixture.js";
import { readMotion } from "../src/motion/store.js";
import { NativeRenderer } from "../src/native/renderer.js";
import { skia, nativeMemory, makeSurface } from "../src/native/skia.js";
import {
  renderNativeFrame,
  closeNativeRenderer,
} from "../src/native/client.js";
import { nativeMotionQA } from "../src/native/qa.js";
import { runIntentTasks } from "../src/motion/intent/execution.js";
import {
  compileTasks,
  compileRequirement,
} from "../src/motion/intent/compiler.js";
import { taskRepairContext } from "../src/motion/intent/repair-context.js";
import {
  verifyWithInfrastructureRecovery,
  failureCategory,
} from "../src/motion/qa/failure.js";
import type { Animation } from "../src/motion/schema.js";
process.env.AKELLA_RENDERER = "native";
after(() => closeNativeRenderer());
test("native memory: 320 uncached Full HD frames, deterministic seek and true Trim Paths after prolonged rendering", async () => {
  const f = await identityFixture(1, (ss) => {
    const line = node("path", "Line", 100, 100, 800, 200);
    line.type = "VECTOR";
    line.properties = {
      ...line.properties,
      fills: [],
      strokes: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }],
      strokeWeight: 4,
      strokeCap: "ROUND",
      vectorPaths: [
        { data: "M0 0 C200 200 600 -100 800 100", windingRule: "NONZERO" },
      ],
    };
    const text = node("text", "Text", 200, 300, 800, 200);
    text.type = "TEXT";
    text.text = {
      characters: "Full HD\nLive typography",
      fontName: { family: "Arial", style: "Regular" },
      fontSize: 48,
    };
    text.properties.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
    ss[0].width = 1920;
    ss[0].height = 1080;
    ss[0].properties = { ...ss[0].properties, width: 1920, height: 1080 };
    ss[0].children = [line, text];
  });
  try {
    f.state.settings = {
      ...f.state.settings,
      width: 1920,
      height: 1080,
      durationFrames: 360,
    };
    f.state.blocks[0].durationFrames = 360;
    f.state.animations = [
      {
        animationId: "trim",
        sceneId: "s0",
        targetId: "path",
        effect: "trimPath",
        enabled: true,
        startFrame: 0,
        durationFrames: 359,
        easing: "linear",
        parameters: { from: 0, to: 1, direction: "forward" },
      },
    ];
    const rows = [];
    let peak = 0;
    for (let i = 0; i < 320; i++) {
      const r = await renderNativeFrame(f.project, f.state, i, {
        encoding: "rgba",
        cache: false,
      });
      assert.equal(r.width, 1920);
      assert.equal(r.height, 1080);
      assert.equal(r.nativeMemory.live, 0);
      assert.equal(r.nativeMemory.liveBytes, 0);
      assert.equal(r.cache.entries, 0);
      peak = Math.max(peak, r.memory.rss);
      if (i % 40 === 0 || i === 319)
        rows.push({ frame: i, rss: r.memory.rss, ...r.nativeMemory });
    }
    const a = await renderNativeFrame(f.project, f.state, 180, {
      encoding: "rgba",
      cache: false,
    });
    await renderNativeFrame(f.project, f.state, 3, {
      encoding: "rgba",
      cache: false,
    });
    const b = await renderNativeFrame(f.project, f.state, 180, {
      encoding: "rgba",
      cache: false,
    });
    assert.deepEqual(a.png, b.png);
    assert.ok(b.paths[0].end > 0 && b.paths[0].end < 1);
    assert.ok(b.paths[0].length > 800);
    assert.ok(peak < 1024 * 1024 * 1024, JSON.stringify({ peak, rows }));
    assert.ok(
      Math.max(...rows.slice(2).map((r) => r.wasmHeapBytes ?? 0)) -
        (rows[2].wasmHeapBytes ?? 0) <
        128 * 1024 * 1024,
      JSON.stringify(rows),
    );
    console.log(
      JSON.stringify({ stressFullHD: { frames: 320, peakRSS: peak, rows } }),
    );
  } finally {
    await f.cleanup();
  }
});
test("native ownership: surfaces are idempotently disposed even on exceptions; repeated object QA batches leave zero live surfaces", async () => {
  const k = await skia();
  try {
    const s = makeSurface(k, 1920, 1080);
    try {
      throw Error("fixture");
    } finally {
      s.dispose();
      s.dispose();
    }
  } catch {}
  assert.equal(nativeMemory(k).live, 0);
  const f = await intentFixture();
  try {
    for (let i = 0; i < 6; i++) {
      const req = objectRequirement(
        "fade",
        "s1",
        i % 2 ? "qr" : "logo",
        i % 2 ? "куар" : "лого",
        ["fadeIn"],
        "fade",
      );
      const plan = {
        schemaVersion: "1.0.0" as const,
        requirements: [req],
        coverage: [],
        assumptions: [],
      };
      const task = compileTasks(f.project, plan)[0],
        compiled = compileRequirement(f.project, f.state, plan, task);
      const { applyOperations } = await import("../src/motion/operations.js");
      const state = applyOperations(f.state, compiled.operations, f.project);
      const qa = await nativeMotionQA(
        f.project,
        state,
        "motion/qa/memory-" + i,
        "fade",
        f.state,
        task.targetReference,
      );
      assert.notEqual(qa.status, "FAILED", JSON.stringify(qa));
      assert.equal(qa.nativeMemory?.live, 0);
      assert.ok(
        qa.renderMetrics.uniqueRequests > 0 &&
          qa.renderMetrics.uniqueRequests <= 24,
      );
      assert.ok(qa.renderMetrics.cachePeakBytes <= 16 * 1024 * 1024);
    }
  } finally {
    await f.cleanup();
  }
});
test("resource failures never trigger semantic repair and preserve independently verified candidate operations", async () => {
  const f = await intentFixture();
  try {
    const reqs = [
        objectRequirement(
          "first",
          "s1",
          "image",
          "image 1926988171",
          ["fadeIn"],
          "first",
        ),
        objectRequirement("second", "s1", "qr", "куар", ["fadeIn"], "second"),
      ],
      plan = {
        schemaVersion: "1.0.0" as const,
        requirements: reqs,
        coverage: [],
        assumptions: [],
      };
    let repairs = 0;
    const result = await runIntentTasks(f.project, f.state, plan, {
      repair: async () => {
        repairs++;
        throw Error("should not run");
      },
      verify: async (task) =>
        task.requirementIds.includes("first")
          ? { status: "PASSED", checks: [] }
          : {
              status: "FAILED",
              checks: [
                {
                  name: "renderedFrames",
                  required: true,
                  status: "FAILED",
                  reason: "SURFACE_ALLOCATION_FAILED: 1920x1080",
                },
              ],
            },
      commit: async (_t, _p, next) => next,
      trace: async () => {},
    });
    assert.equal(repairs, 0);
    assert.equal(result.reconciliation.status, "PARTIAL_SUCCESS");
    assert.equal(result.requirements[0].status, "PASSED");
    assert.equal(result.requirements[1].status, "FAILED");
    assert.equal(
      result.next.animations.filter((a) => a.targetId === "image").length,
      1,
    );
    assert.equal(
      result.next.animations.filter((a) => a.targetId === "qr").length,
      0,
    );
    assert.ok((result.tasks[1].generatedOperations?.length ?? 0) > 0);
    assert.match(result.tasks[1].error ?? "", /RENDER_INFRASTRUCTURE_FAILED/);
  } finally {
    await f.cleanup();
  }
});
test("repair projection is bounded regardless of unrelated state/history, with required techniques and actual operations retained", async () => {
  const f = await intentFixture();
  try {
    const state = (await readMotion(f.project)).state;
    const task = compileTasks(f.project, f.plan).find(
        (t) => t.targetReference.targetId === "qr",
      )!,
      compiled = compileRequirement(f.project, state, f.plan, task),
      feedback = {
        failureReason: "MOTION_QA_FAILED",
        actualOperations: compiled.operations,
        failedChecks: [
          {
            name: "test",
            reason: "actual failure",
            metrics: { count: 1, pixels: Array(10000).fill(1) },
          },
        ],
        previousResponse: "x".repeat(200000),
      };
    const a = taskRepairContext(f.project, state, f.plan, task, feedback);
    const base = {
      animationId: "unused",
      sceneId: "s1",
      targetId: "logo",
      effect: "fadeIn",
      startFrame: 0,
      durationFrames: 1,
      enabled: false,
      easing: "linear",
      parameters: { from: 0, to: 1 },
    } as Animation;
    const b = taskRepairContext(
      f.project,
      {
        ...state,
        animations: Array.from({ length: 1000 }, (_, i) => ({
          ...base,
          animationId: "unused-" + i,
        })),
      },
      f.plan,
      task,
      feedback,
    );
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.ok(Buffer.byteLength(JSON.stringify(a)) < 12000);
    assert.deepEqual(a.previousOperations, compiled.operations);
    assert.deepEqual(a.scope.techniques, task.techniques);
    assert.throws(
      () => taskRepairContext(f.project, state, f.plan, task, feedback, 100),
      /REPAIR_CONTEXT_BUDGET/,
    );
    assert.equal(
      failureCategory("CONTEXT_EXHAUSTED: schema too large"),
      "provider-or-budget",
    );
  } finally {
    await f.cleanup();
  }
});
test("infrastructure recovery is bounded to one worker reset and preserves the original failure on unsuccessful recovery", async () => {
  let n = 0,
    resets = 0;
  const failed = {
    status: "FAILED",
    checks: [
      {
        status: "FAILED",
        name: "renderedFrames",
        reason: "Aborted(). Build with -sASSERTIONS",
      },
    ],
  };
  const r = await verifyWithInfrastructureRecovery(
    async () => (++n === 1 ? failed : { status: "PASSED", checks: [] }),
    async () => {
      resets++;
    },
    async () => {},
  );
  assert.equal(r.status, "PASSED");
  assert.equal(resets, 1);
  assert.equal(n, 2);
  n = 0;
  await verifyWithInfrastructureRecovery(
    async () => {
      n++;
      return failed;
    },
    async () => {},
    async () => {},
  );
  assert.equal(n, 2);
});
test("task repair full strict-wire request including response schema fits 60 KB", async () => {
  const { AIClient } = await import("../src/motion/provider.js");
  const { planSchema } = await import("../src/motion/schema.js");
  const { taskRepairInstructions } = await import(
    "../src/motion/intent/repair-context.js"
  );
  const { registerProvider } = await import(
    "../src/harness/providers/types.js"
  );
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "repair-wire-"));
  let bytes = 0;
  const stop = registerProvider("repair-wire-fixture", () => ({
    id: "repair-wire-fixture",
    mode: "mock",
    capabilities: () => ({
      structuredOutput: true,
      nativeToolCalling: false,
      cancellation: true,
      usage: false,
      nativeOutputTokenLimit: false,
    }),
    generate: async (input) => {
      bytes =
        Buffer.byteLength(JSON.stringify(input.messages)) +
        Buffer.byteLength(JSON.stringify(input.responseSchema));
      assert.ok(bytes < 60000, `full request ${bytes}`);
      return {
        output: {
          status: "unsupported",
          summary: "fixture",
          assumptions: [],
          warnings: [],
          operations: [],
        },
        usage: null,
        estimatedCost: null,
        latencyMs: 0,
        diagnostics: [],
        toolCalls: [],
      };
    },
  }));
  try {
    await new AIClient(
      { provider: "repair-wire-fixture", model: "fixture" },
      dir,
    ).structured(
      { taskContext: "x".repeat(12000) },
      "Repair exact failed checks",
      taskRepairInstructions,
      planSchema,
      "task-repair",
    );
    console.log(JSON.stringify({ repairMaximumFullWireBytes: bytes }));
  } finally {
    stop();
    await rm(dir, { recursive: true, force: true });
  }
});
