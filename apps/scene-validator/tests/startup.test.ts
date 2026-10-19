import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  intentFixture,
  objectRequirement,
  compositeRequest,
} from "./intent-fixture.js";
import { agentContext } from "../src/harness/context.js";
import { harnessConfig } from "../src/harness/config.js";
import { codeVersions } from "../src/harness/versions.js";
import { HarnessRun, readRuns } from "../src/harness/runtime.js";
import { duringStage } from "../src/harness/failure.js";
import { inspectorRun } from "../src/harness/inspector.js";
import { executeMotion } from "../src/motion/service.js";
import { readMotion } from "../src/motion/store.js";
import {
  registerProvider,
  type ProviderAdapter,
} from "../src/harness/providers/index.js";
import { closeNativeRenderer } from "../src/native/client.js";
process.env.AKELLA_RENDERER = "native";
after(() => closeNativeRenderer());
test("startup: source versions include native architecture and required missing modules fail explicitly", async () => {
  const versions = await codeVersions();
  assert.ok(versions.some((v) => v.id === "code:native/renderer"));
  assert.ok(versions.some((v) => v.id === "code:motion/evaluation"));
  assert.ok(versions.every((v) => /^[a-f0-9]{64}$/.test(v.version)));
  const dir = await mkdtemp(path.join(os.tmpdir(), "startup-version-"));
  try {
    await assert.rejects(
      codeVersions(pathToFileURL(dir + "/"), ["missing-required"]),
      /SOURCE_VERSION_REQUIRED_MISSING: missing-required/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("startup: admission budgets the SAME semantic wire projection, not oversized internal diagnostic state", async () => {
  const f = await intentFixture();
  try {
    const cfg = await harnessConfig(f.project.root),
      c = await agentContext(
        f.project,
        f.state,
        { request: compositeRequest },
        [],
        cfg,
      );
    assert.ok(c.internalBytes > c.bytes);
    const budget = Math.max(4000, Math.ceil((c.internalBytes + c.bytes) / 2));
    const bounded = await agentContext(
      f.project,
      f.state,
      { request: compositeRequest },
      [],
      { ...cfg, maxContextBytes: budget },
    );
    assert.ok(bounded.internalBytes > budget);
    assert.ok(bounded.bytes < budget);
    assert.deepEqual(bounded.value.objectIndex, c.value.objectIndex);
  } finally {
    await f.cleanup();
  }
});
test("startup: production context → mock provider → actual native QA → committed result; early failure is diagnostic and atomic", async () => {
  const f = await intentFixture();
  let calls = 0;
  const unregister = registerProvider(
    "startup-fixture",
    () =>
      ({
        id: "startup-fixture",
        mode: "mock",
        capabilities: () => ({
          structuredOutput: true,
          nativeToolCalling: false,
          cancellation: true,
          usage: false,
          nativeOutputTokenLimit: false,
        }),
        generate: async (request) => {
          calls++;
          const { userRequest } = JSON.parse(request.messages[1].content);
          return {
            output: {
              schemaVersion: "1.0.0",
              requirements: [
                objectRequirement(
                  "fade",
                  "s1",
                  "qr",
                  "куар",
                  ["fadeIn"],
                  userRequest,
                ),
              ],
              coverage: [
                {
                  sourceText: userRequest,
                  requirementIds: ["fade"],
                  classification: "executable",
                  explanation: "fixture",
                },
              ],
              assumptions: [],
            },
            usage: null,
            estimatedCost: null,
            latencyMs: 0,
            diagnostics: ["mock startup test"],
            toolCalls: [],
          };
        },
      }) satisfies ProviderAdapter,
  );
  try {
    const input = async () => ({
      mode: "create",
      request: "куар появляется через фейд",
      selectedObjectId: "qr",
      selectedSceneId: "s1",
      settings: { provider: "startup-fixture", model: "" },
      expectedRevision: (await readMotion(f.project)).revision,
    });
    const result = await executeMotion(f.project, await input());
    assert.equal(calls, 1);
    assert.equal(result.reconciliation?.status, "SUCCESS");
    const before = await readFile(
      path.join(f.project.root, "motion/motion.json"),
    );
    await assert.rejects(
      executeMotion(f.project, await input(), () => {}, {
        config: { maxContextBytes: 4000 },
      }),
      /CONTEXT_BUDGET/,
    );
    assert.equal(calls, 1);
    assert.deepEqual(
      await readFile(path.join(f.project.root, "motion/motion.json")),
      before,
    );
    const failed = (await readRuns(f.project.root)).find(
      (r) => r.status === "FAILED",
    )!;
    assert.ok(failed);
    const view = (await inspectorRun(
      f.project.root,
      String(failed.runId),
    )) as unknown as {
      startupFailure: {
        failureStage: string;
        errorCode: string;
        errorMessage: string;
        providerInitializationStatus: string;
      };
    };
    assert.equal(view.startupFailure.failureStage, "context-construction");
    assert.equal(view.startupFailure.errorCode, "CONTEXT_BUDGET");
    assert.match(view.startupFailure.errorMessage, /4000/);
    assert.equal(
      view.startupFailure.providerInitializationStatus,
      "SETTINGS_VALIDATED",
    );
  } finally {
    unregister();
    await f.cleanup();
  }
});
test("startup: source/native errors retain stage and safe root cause, metadata privacy excludes details and cancellation cannot block diagnostics", async () => {
  const f = await intentFixture();
  try {
    for (const privacy of ["full", "metadata"] as const) {
      const run = await HarnessRun.start(
        f.project,
        crypto.randomUUID(),
        "fixture",
        null,
        "",
        undefined,
        { privacy },
      );
      let failure;
      try {
        await duringStage("source-versions", () =>
          codeVersions(new URL("file:///missing-startup-fixture/"), [
            "required",
          ]),
        );
      } catch (e) {
        failure = e;
      }
      run.controller.abort();
      await run.captureFailure(failure);
      await run.finish("FAILED");
      const saved = JSON.parse(
        await readFile(
          path.join(
            f.project.root,
            "motion/harness/runs",
            run.runId,
            "run.json",
          ),
          "utf8",
        ),
      );
      assert.equal(saved.status, "FAILED");
      assert.equal(saved.failure.failureStage, "source-versions");
      assert.equal(saved.failure.errorCode, "SOURCE_VERSION_REQUIRED_MISSING");
      assert.equal(saved.calls.length, 0);
      if (privacy === "metadata") {
        assert.equal(saved.failure.rootCause, "REDACTED");
        assert.deepEqual(saved.failure.safeStackTrace, []);
      } else assert.match(saved.failure.rootCause, /required.js/);
    }
  } finally {
    await f.cleanup();
  }
});

test("startup: native initialization failures redact credentials and private paths in persisted diagnostics", async () => {
  const f = await intentFixture();
  try {
    const run = await HarnessRun.start(
      f.project,
      crypto.randomUUID(),
      "fixture",
      null,
      "",
    );
    let failure;
    try {
      await duringStage("native-dependency-initialization", () => {
        throw Object.assign(
          new Error(
            "NATIVE_INIT_FAILED: " +
              process.cwd() +
              "/node_modules/canvaskit-wasm sk-" +
              "x".repeat(32),
          ),
          { code: "MODULE_NOT_FOUND" },
        );
      });
    } catch (error) {
      failure = error;
    }
    await run.captureFailure(failure);
    await run.finish("FAILED");
    const saved = JSON.parse(
      await readFile(
        path.join(f.project.root, "motion/harness/runs", run.runId, "run.json"),
        "utf8",
      ),
    );
    assert.equal(
      saved.failure.failureStage,
      "native-dependency-initialization",
    );
    assert.equal(saved.failure.errorCode, "MODULE_NOT_FOUND");
    const json = JSON.stringify(saved.failure);
    assert.ok(!json.includes(process.cwd()));
    assert.ok(!json.includes("sk-" + "x".repeat(32)));
    assert.match(json, /REDACTED_KEY/);
  } finally {
    await f.cleanup();
  }
});
