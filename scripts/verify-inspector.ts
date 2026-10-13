import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import JSZip from "jszip";
const base = "http://127.0.0.1:4173",
  id = "f7866ce5-3bcb-49e9-b8ee-f1bbc055b4bd";
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  const errors: string[] = [];
  const requests: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => requests.push(r.method() + " " + r.url()));
  await page.goto(base + "/#project/" + id);
  await page.locator("#m-inspector").waitFor();
  await page.locator("#m-inspector").click();
  await page
    .locator(".agent-inspector select option")
    .first()
    .waitFor({ state: "attached" });
  await page.waitForFunction(() =>
    document
      .querySelector(".inspector-body")
      ?.textContent?.includes("Длительность"),
  );
  await page.screenshot({ path: "artifacts/agent-inspector/overview.png" });
  for (const tab of [1, 2, 3, 4]) {
    await page.locator(`[data-tab="${tab}"]`).click();
    await page.waitForTimeout(200);
  }
  await page.locator("[data-json]").waitFor();
  await page.locator("[data-json]").click();
  assert.match(
    await page.evaluate(() => navigator.clipboard.readText()),
    /runId/,
  );
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await page.locator("[data-copy]").click();
  let clipboard = "";
  for (let i = 0; i < 50; i++) {
    clipboard = await page.evaluate(() => navigator.clipboard.readText());
    if (clipboard.startsWith("# Motion Agent Debug Report")) break;
    await page.waitForTimeout(100);
  }
  assert.ok(
    clipboard.startsWith("# Motion Agent Debug Report"),
    `Clipboard starts with: ${clipboard.slice(0, 60)}`,
  );
  const downloadPromise = page.waitForEvent("download");
  await page.locator("[data-zip]").click();
  const download = await downloadPromise;
  await download.saveAs("artifacts/agent-inspector/debug-bundle.zip");
  const file = await import("node:fs/promises");
  const zip = await JSZip.loadAsync(
    await file.readFile("artifacts/agent-inspector/debug-bundle.zip"),
  );
  assert.ok(zip.file("report.md"));
  await writeFile(
    "artifacts/agent-inspector/report.md",
    await zip.file("report.md")!.async("string"),
  );
  await page.locator('[data-tab="3"]').click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: "artifacts/agent-inspector/qa.png" });
  const grip = page.locator(".inspector-resize");
  const bounds = await grip.boundingBox();
  await page.mouse.move(bounds!.x + 5, 100);
  await page.mouse.down();
  await page.mouse.move(bounds!.x - 100, 100);
  await page.mouse.up();
  assert.ok(
    (await page.locator(".agent-inspector").evaluate((el) => el.clientWidth)) >
      520,
  );
  await page.locator("[data-close]").click();
  assert.equal(await page.locator(".agent-inspector").isVisible(), false);
  await page.locator("#m-inspector").click();
  assert.ok(
    await page
      .locator('[data-tab="3"]')
      .evaluate((el) => el.classList.contains("active")),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "artifacts/agent-inspector/mobile.png" });
  // Live polling uses synthetic saved-run HTTP responses; no provider is invoked.
  await page.setViewportSize({ width: 1440, height: 960 });
  const liveId = "00000000-0000-4000-8000-000000000001";
  let snapshots = 0;
  await page.route("**/motion/inspector", async (route) => {
    snapshots++;
    await route.fulfill({
      json: [
        {
          runId: liveId,
          createdAt: new Date().toISOString(),
          status: snapshots < 2 ? "RUNNING" : "FAILED",
          metrics: { llmCalls: 0 },
        },
      ],
    });
  });
  await page.route("**/motion/inspector/" + liveId, async (route) => {
    await route.fulfill({
      json: {
        run: {
          runId: liveId,
          status: snapshots < 2 ? "RUNNING" : "FAILED",
          metrics: { llmCalls: 0 },
        },
        prompt: "Synthetic live observation fixture",
        trace: [],
        understanding: { tasks: [] },
        qa: [],
        stateChanges: [],
      },
    });
  });
  await page.locator('[data-tab="0"]').click();
  await page.waitForFunction(() =>
    document
      .querySelector(".inspector-body")
      ?.textContent?.includes("Synthetic live observation fixture"),
  );
  await page.waitForFunction(
    () =>
      document.querySelector(".inspector-body > .inspector-status")
        ?.textContent === "FAILED",
  );
  assert.ok(snapshots >= 2);
  assert.deepEqual(errors, []);
  assert.ok(
    !requests.some((r) => r.startsWith("POST ")),
    "Inspector must not generate or render via POST",
  );
  await writeFile(
    "artifacts/agent-inspector/browser-check.json",
    JSON.stringify(
      {
        projectId: id,
        checks: [
          "open",
          "five tabs",
          "clipboard JSON",
          "clipboard Markdown",
          "download ZIP",
          "resize",
          "close",
          "persistent selected tab",
          "mobile",
          "live status updates (synthetic HTTP fixture)",
          "no POST/provider/render calls",
        ],
        errors,
        requests,
      },
      null,
      2,
    ),
  );
  console.log(
    "Inspector browser checks PASSED; existing test6 data, no AI calls",
  );
} finally {
  await browser.close();
}
