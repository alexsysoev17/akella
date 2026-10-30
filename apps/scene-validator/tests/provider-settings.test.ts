import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { intentFixture, objectRequirement } from "./intent-fixture.js";
import { servePlatform } from "../src/platform-server.js";
import {
  providerSettingsSchema,
  loadProviderSettings,
  saveProviderSettings,
  ProviderSettingsError,
} from "../src/motion/provider-settings.js";
import {
  registerProvider,
  createProvider,
  providerIds,
} from "../src/harness/providers/index.js";
import { projectMotion } from "../src/motion/service.js";
import { readMotion } from "../src/motion/store.js";
import { readRuns } from "../src/harness/runtime.js";
import { inspectorRun } from "../src/harness/inspector.js";
import { selectedProviderId } from "../src/provider-contract.js";
const requestText = "QR снизу с инерцией";
const file = (f: Awaited<ReturnType<typeof intentFixture>>) =>
  path.join(f.project.root, "motion/ai/provider.json");
async function put(f: Awaited<ReturnType<typeof intentFixture>>, v: unknown) {
  await mkdir(path.dirname(file(f)), { recursive: true });
  await writeFile(file(f), JSON.stringify(v));
}
async function serverFixture() {
  const f = await intentFixture();
  const server = await servePlatform(path.dirname(f.project.root), 0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const root = `http://127.0.0.1:${address.port}`,
    api = root + `/api/projects/${f.project.config.projectId}/motion`;
  return {
    f,
    server,
    root,
    api,
    cleanup: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await f.cleanup();
    },
  };
}
async function post(url: string, value: unknown) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}
test("canonical SDK/CLI/default settings agree with Registry; invalid syntax and unregistered IDs fail without weakening format", async () => {
  assert.equal(
    providerSettingsSchema.parse({ provider: "codex-sdk" }).provider,
    "codex-sdk",
  );
  assert.equal(
    providerSettingsSchema.parse({ provider: "codex-cli" }).provider,
    "codex-cli",
  );
  assert.equal(providerSettingsSchema.parse({}).provider, "codex-sdk");
  assert.equal(selectedProviderId("codex-sdk", providerIds()), "codex-sdk");
  for (const id of [
    "",
    "Codex SDK",
    "codex_sdk",
    " codex-sdk",
    "unknown-provider",
  ])
    assert.equal(
      providerSettingsSchema.safeParse({ provider: id }).success,
      false,
    );
  for (const id of ["codex-sdk", "codex-cli"]) {
    const adapter = createProvider(id, "/tmp");
    assert.equal(adapter.id, id);
    assert.equal(adapter.mode, "live");
  }
});
test("valid old config, missing config, known display aliases migrate precisely; unknown config stays intact; transient mocks never persist", async () => {
  const f = await intentFixture();
  const stop = registerProvider("transient-fixture", () => ({
    id: "transient-fixture",
    mode: "mock",
    capabilities: () => ({
      structuredOutput: true,
      nativeToolCalling: false,
      cancellation: true,
      usage: false,
      nativeOutputTokenLimit: false,
    }),
    generate: async () => {
      throw new Error("No model call");
    },
  }));
  try {
    assert.equal((await loadProviderSettings(f.project)).source, "default");
    await put(f, { provider: "codex-cli", model: "" });
    assert.deepEqual((await loadProviderSettings(f.project)).settings, {
      provider: "codex-cli",
      model: "",
    });
    assert.equal(
      (
        await saveProviderSettings(f.project, {
          provider: "transient-fixture",
          model: "",
        })
      ).persisted,
      false,
    );
    assert.equal(
      JSON.parse(await readFile(file(f), "utf8")).provider,
      "codex-cli",
    );
    await put(f, { provider: "Codex SDK", model: "" });
    assert.equal(
      (await loadProviderSettings(f.project)).settings.provider,
      "codex-sdk",
    );
    assert.equal(
      JSON.parse(await readFile(file(f), "utf8")).provider,
      "codex-sdk",
    );
    await put(f, { provider: "saved-intent-replay", model: "" });
    const before = await readFile(file(f), "utf8");
    await assert.rejects(
      loadProviderSettings(f.project),
      ProviderSettingsError,
    );
    assert.equal(await readFile(file(f), "utf8"), before);
    assert.equal((await projectMotion(f.project)).provider, null);
  } finally {
    stop();
    await f.cleanup();
  }
});
test("API rejects empty/invalid/unknown provider immediately with friendly error, zero calls, preserved state and safe Inspector diagnostics", async () => {
  const x = await serverFixture();
  try {
    const doc = await readMotion(x.f.project);
    for (const id of [
      "",
      "Codex SDK",
      "unknown-provider",
      "sk-proj-" + "a".repeat(40),
    ]) {
      const response = await post(x.api + "/execute", {
        mode: "create",
        request: requestText,
        expectedRevision: doc.revision,
        settings: { provider: id, model: "" },
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.errorCode, "PROVIDER_SETTINGS_INVALID");
      assert.ok(body.error.includes("Ошибка настройки"));
      assert.ok(!body.error.includes("invalid_format"));
      assert.ok(
        !JSON.stringify(body).includes(
          id.startsWith("sk-") ? id : "NON_EXPECTED_SECRET",
        ),
      );
    }
    assert.deepEqual(await readMotion(x.f.project), doc);
    const runs = await readRuns(x.f.project.root);
    assert.equal(runs.length, 4);
    for (const run of runs) {
      assert.equal((run.metrics as { llmCalls: number }).llmCalls, 0);
      const view = await inspectorRun(x.f.project.root, String(run.runId));
      assert.ok(
        JSON.stringify(view.providerSettingsValidation).includes(
          "NOT_INITIALIZED",
        ),
      );
      assert.ok(!JSON.stringify(view).includes("sk-proj-" + "a".repeat(40)));
    }
    const projected=await Promise.all(runs.map(run=>inspectorRun(x.f.project.root,String(run.runId))));
    assert.ok(projected.some(view=>JSON.stringify(view.providerSettingsValidation).includes('"actualValue":""')));
  } finally {
    await x.cleanup();
  }
});
test("actual API create uses semantic provider, clear follow-up edits locally; canonical settings cannot overwrite persisted live selection", async () => {
  const x = await serverFixture();
  let calls = 0;
  const stop = registerProvider("codex-sdk", () => ({
    id: "codex-sdk",
    mode: "mock",
    capabilities: () => ({
      structuredOutput: true,
      nativeToolCalling: false,
      cancellation: true,
      usage: false,
      nativeOutputTokenLimit: false,
    }),
    generate: async (req) => {
      calls++;
      const text = JSON.parse(req.messages[1].content).userRequest;
      const r = objectRequirement(
        "qr",
        "s1",
        "qr",
        "куар",
        calls === 1 ? ["slideUp", "inertialOvershoot"] : ["inertialOvershoot"],
        text,
      );
      if (calls > 1) {
        r.kind = "editAnimation";
        r.parameters.amplitudeFactor = 0.5;
        r.timing.relation = "unchanged";
      }
      return {
        output: {
          schemaVersion: "1.0.0",
          requirements: [r],
          coverage: [
            {
              sourceText: text,
              requirementIds: ["qr"],
              classification: "executable",
              explanation: "infrastructure mock",
            },
          ],
          assumptions: [],
        },
        usage: null,
        estimatedCost: null,
        latencyMs: 1,
        diagnostics: ["mock, not live provider E2E"],
        toolCalls: [],
      };
    },
  }));
  try {
    await put(x.f, { provider: "codex-cli", model: "" });
    for (const text of [requestText, "QR вдвое слабее"]) {
      const before = await readMotion(x.f.project);
      const response = await post(x.api + "/execute", {
        mode: calls ? "edit" : "create",
        request: text,
        expectedRevision: before.revision,
        settings: { provider: "codex-sdk", model: "" },
      });
      assert.equal(response.status, 202);
      const { jobId } = await response.json();
      let job;
      for (let i = 0; i < 300; i++) {
        job = await (await fetch(x.api + "/jobs/" + jobId)).json();
        if (job.status !== "running") break;
        await new Promise((r) => setTimeout(r, 30));
      }
      assert.equal(job.status, "completed", JSON.stringify(job));
      assert.equal(job.result.reconciliation.status, "SUCCESS");
      assert.equal(
        JSON.parse(await readFile(file(x.f), "utf8")).provider,
        "codex-cli",
      );
    }
    assert.equal(calls, 1); // Existing-effect follow-up is now LOCAL_DETERMINISTIC_EDIT.
  } finally {
    stop();
    assert.equal(createProvider("codex-sdk", "/tmp").mode, "live");
    await x.cleanup();
  }
});
test("real browser labels send canonical IDs; SDK/CLI switching persists and reloads, corrupt config stays visibly blocked until explicit choice", async () => {
  const x = await serverFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1400, height: 1000 },
    });
    await page.goto(x.root + "/#project/" + x.f.project.config.projectId);
    await page.locator("#m-open-settings").click();
    assert.equal(await page.locator("#m-provider").inputValue(), "codex-sdk");
    assert.equal(await page.evaluate(() => {
      const select = document.createElement("select");
      select.innerHTML = '<option value="codex-sdk">Codex SDK</option><option value="codex-cli">Codex CLI</option>';
      select.value = "saved-intent-replay";
      return select.value;
    }), "");
    assert.equal(
      await page.locator('#m-provider option[value="codex-sdk"]').textContent(),
      "Codex SDK",
    );
    for (const id of ["codex-cli", "codex-sdk"]) {
      const saved = page.waitForResponse(
        (r) =>
          r.url().endsWith("/provider-settings") &&
          r.request().method() === "POST",
      );
      await page.locator("#m-provider").selectOption(id);
      const response = await saved;
      assert.equal(response.request().postDataJSON().provider, id);
      assert.equal(response.status(), 200);
      await page.reload();
      await page.locator("#m-open-settings").click();
      assert.equal(await page.locator("#m-provider").inputValue(), id);
    }
    await put(x.f, { provider: "saved-intent-replay", model: "" });
    await page.reload();
    await page.locator("#m-open-settings").click();
    assert.equal(await page.locator("#m-provider").inputValue(), "");
    assert.equal(await page.locator("#m-generate").isDisabled(), true);
    assert.ok(
      (await page.locator("#m-error").textContent())!.includes(
        "Ошибка настройки",
      ),
    );
    assert.equal(
      JSON.parse(await readFile(file(x.f), "utf8")).provider,
      "saved-intent-replay",
    );
    const fixed = page.waitForResponse((r) =>
      r.url().endsWith("/provider-settings"),
    );
    await page.locator("#m-provider").selectOption("codex-sdk");
    await fixed;
    assert.equal(
      JSON.parse(await readFile(file(x.f), "utf8")).provider,
      "codex-sdk",
    );
  } finally {
    await browser.close();
    await x.cleanup();
  }
});
