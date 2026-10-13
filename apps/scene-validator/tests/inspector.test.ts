import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import JSZip from "jszip";
import {
  inspectorRun,
  inspectorRuns,
  debugReport,
  debugBundle,
  debugSafe,
  qaCategories,
} from "../src/harness/inspector.js";
import { retainRuns } from "../src/harness/retention.js";
async function fixture(status = "SUCCESS", privacy = "full") {
  const root = await mkdtemp(path.join(tmpdir(), "inspector-")),
    id = randomUUID();
  const put = async (p: string, v: unknown) => {
    const f = path.join(root, p);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, JSON.stringify(v));
  };
  const run = {
    runId: id,
    createdAt: new Date().toISOString(),
    status,
    privacy,
    calls: [
      { provider: "local-fixture", model: "synthetic", status: "SUCCESS" },
    ],
    metrics: { llmCalls: 1 },
    outcome: {
      reconciliation: { requested: 1, completed: status === "SUCCESS" ? 1 : 0 },
    },
    result: { requirements: [{ techniques: ["slideUp", "fadeIn"], status }] },
  };
  await put(`motion/harness/runs/${id}/run.json`, run);
  await put(`motion/harness/runs/${id}/trace.json`, [
    {
      stage: "received",
      at: new Date().toISOString(),
      durationMs: 0,
      data: { request: "QR снизу с фейдом" },
    },
  ]);
  await put(`motion/ai/${id}/tasks.json`, {
    contract: {
      requirements: [
        {
          requirementId: "r1",
          sourceText: "QR снизу с фейдом",
          sceneId: "scene2",
          target: { name: "QR", sourceNodeId: "15:5212" },
          techniques: ["slideUp", "fadeIn"],
          status,
        },
      ],
    },
    tasks: [
      {
        taskId: "task_1234567890abcdef",
        status,
        targetReference: { name: "QR", sourceNodeId: "15:5212" },
        generatedOperations: [
          {
            type: "setExpression",
            expression: {
              type: "inertialOvershoot",
              parameters: { mode: "ae", amp: 0.1 },
            },
          },
        ],
        repairHistory: [
          { attempt: 1, error: "missing fade" },
          { attempt: 2, changed: false },
        ],
      },
    ],
  });
  const attempt = "task_1234567890abcdef-attempt-1";
  await put(`motion/qa/${id}/${attempt}/report.json`, {
    status: "FAILED",
    checks: [
      {
        name: "MASK_BOUNDS_VALIDATION",
        status: "FAILED",
        target: "15:5212",
        reason: "clipping",
        metrics: { frames: [30, 45] },
      },
      { name: "finiteState", status: "PASSED" },
    ],
  });
  await writeFile(
    path.join(root, `motion/qa/${id}/${attempt}/frame-00030.png`),
    Buffer.from("synthetic-png"),
  );
  return { root, id, put, run };
}
test("Inspector projects real persisted intent, targets, missing fade, QA and repairs", async () => {
  const f = await fixture("PARTIAL_SUCCESS"),
    v = await inspectorRun(f.root, f.id);
  assert.equal((v.run as { status: string }).status, "PARTIAL_SUCCESS");
  assert.match(JSON.stringify(v.understanding), /15:5212/);
  assert.match(JSON.stringify(v.understanding), /fadeIn/);
  assert.match(JSON.stringify(v.understanding), /changed":false/);
  assert.match(JSON.stringify(v.qa), /clipping/);
  assert.match(JSON.stringify(v.qa), /30,45/);
  assert.equal(v.artisticQA, "NOT_TESTED");
  assert.match(debugReport(v), /QR снизу с фейдом/);
  assert.match(debugReport(v), /missing fade/);
});
test("Run history survives readers/restart and provider failures without changing state or calls", async () => {
  const f = await fixture("FAILED");
  const before = await readFile(
    path.join(f.root, `motion/harness/runs/${f.id}/run.json`),
    "utf8",
  );
  for (let i = 0; i < 3; i++) {
    assert.equal((await inspectorRuns(f.root)).length, 1);
    await inspectorRun(f.root, f.id);
  }
  assert.equal(
    await readFile(
      path.join(f.root, `motion/harness/runs/${f.id}/run.json`),
      "utf8",
    ),
    before,
  );
  assert.match(
    JSON.stringify(await inspectorRun(f.root, f.id)),
    /local-fixture/,
  );
});
test("Debug bundle contains bounded actual diagnostics and existing QA frames, no source assets", async () => {
  const f = await fixture(),
    zip = await JSZip.loadAsync(await debugBundle(f.root, f.id));
  for (const name of [
    "report.md",
    "run.json",
    "intent.json",
    "operations.json",
    "qa-report.json",
    "state-diff.json",
    "environment.json",
    "trace.json",
  ])
    assert.ok(zip.file(name));
  assert.ok(Object.keys(zip.files).some((n) => n.endsWith("frame-00030.png")));
  assert.ok(!Object.keys(zip.files).some((n) => n.includes("source/")));
  assert.match(await zip.file("report.md")!.async("string"), /SUCCESS/);
});
test("Credentials, authentication, geometry, binary and personal paths are redacted", async () => {
  const f = await fixture();
  await f.put(`motion/ai/${f.id}/request.json`, {
    apiKey: "private-key",
    password: "p",
    request:
      "Bearer abcdefghijklmnop /Users/person/Desktop sk-abcdefghijklmnop",
    svg: "<svg>secret</svg>",
  });
  const text = JSON.stringify(await inspectorRun(f.root, f.id, true));
  assert.ok(!text.includes("private-key"));
  assert.ok(!text.includes("abcdefghijklmnop"));
  assert.ok(!text.includes("/Users/person"));
  assert.ok(!text.includes("<svg>"));
  assert.equal(
    (debugSafe({ geometry: "big" }) as { geometry: string }).geometry,
    "[OMITTED]",
  );
});
test("Metadata privacy does not disclose intent, state or QA images", async () => {
  const f = await fixture("SUCCESS", "metadata"),
    v = await inspectorRun(f.root, f.id, true);
  assert.equal(v.understanding, "NOT_AVAILABLE");
  assert.deepEqual(v.qa, []);
  assert.deepEqual(v.stateChanges, []);
});
test("Reject traversal IDs and symlink diagnostic paths", async () => {
  const f = await fixture();
  await assert.rejects(() => inspectorRun(f.root, "../source"));
  const outside = await mkdtemp(path.join(tmpdir(), "outside-"));
  await symlink(outside, path.join(f.root, "motion/ai", randomUUID()));
  const g = await fixture();
  const id = randomUUID();
  await symlink(outside, path.join(g.root, "motion/harness/runs", id));
  await assert.rejects(() => inspectorRuns(g.root));
});
test("QA categories preserve non-tested checks and never invent artistic pass", () => {
  const q = qaCategories({
    checks: [
      { name: "renderedPathReveal", status: "FAILED" },
      { name: "visibleOscillation", status: "PASSED" },
      { name: "geometry", status: "NOT_TESTED" },
    ],
  });
  assert.equal(q.artistic, "NOT_TESTED");
  assert.match(JSON.stringify(q.render), /FAILED/);
  assert.match(JSON.stringify(q.mathematics), /PASSED/);
  assert.match(JSON.stringify(q.technical), /NOT_TESTED/);
});
test("Retention removes old run records while preserving active/current runs and user data", async () => {
  const f = await fixture();
  const old = randomUUID(),
    active = randomUUID();
  for (const [id, status] of [
    [old, "FAILED"],
    [active, "RUNNING"],
  ])
    await f.put(`motion/harness/runs/${id}/run.json`, {
      runId: id,
      status,
      createdAt: "2020-01-01T00:00:00Z",
    });
  await f.put("source/scene.json", { preserved: true });
  await retainRuns(
    f.root,
    { maxRuns: 2, maxAgeDays: 90, maxBytes: 10000000 },
    f.id,
  );
  assert.equal((await inspectorRuns(f.root)).length, 2);
  assert.match(
    await readFile(path.join(f.root, "source/scene.json"), "utf8"),
    /preserved/,
  );
});

test("Overshoot diagnostics preserve evaluator parameters and velocity sampling source", async () => {
  const f = await fixture(),
    v = await inspectorRun(f.root, f.id);
  assert.match(JSON.stringify(v.evaluator), /sampling.ts/);
  assert.match(JSON.stringify(v.evaluator), /FPS/);
  assert.match(JSON.stringify(v.evaluator), /"mode":"ae"/);
});

test("Wrong target binding stays visible with its actual validation error", async () => {
  const f = await fixture("FAILED");
  await f.put(`motion/ai/${f.id}/tasks.json`, {
    contract: {
      requirements: [
        {
          requirementId: "r1",
          sourceText: "лого аналогично",
          sceneId: "scene2",
          target: { name: "Wrong Logo", sourceNodeId: "99:wrong" },
          techniques: ["slideUp", "fadeIn"],
        },
      ],
    },
    tasks: [
      {
        taskId: "task_1234567890abcdef",
        status: "FAILED",
        targetReference: { name: "Wrong Logo", sourceNodeId: "99:wrong" },
        error: "TARGET_NOT_FOUND",
        validationResult: { status: "FAILED", code: "TARGET_NOT_FOUND" },
        generatedOperations: [],
      },
    ],
  });
  const v = await inspectorRun(f.root, f.id);
  assert.match(JSON.stringify(v.understanding), /99:wrong/);
  assert.match(debugReport(v), /TARGET_NOT_FOUND/);
  assert.deepEqual(v.stateChanges, []);
});
