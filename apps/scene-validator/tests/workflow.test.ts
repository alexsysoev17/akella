import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  writeFile,
  readdir,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import JSZip from "jszip";
import { servePlatform } from "../src/platform-server.js";
import { comparePixels } from "../src/comparison.js";
import { fingerprint, inventory } from "../src/files.js";
const identity = [
  [1, 0, 0],
  [0, 1, 0],
];
async function exportZip(count: number, png: Buffer, changed = false) {
  const zip = new JSZip();
  const folder = zip.folder("motion-project")!;
  folder.file("assets/image.png", png);
  folder.file(
    "assets/vector.svg",
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>',
  );
  folder.file("export-report.json", JSON.stringify({ errorCount: 0 }));
  folder.file(
    "scene.json",
    JSON.stringify({
      schemaVersion: "1.0.0",
      assets: [
        { assetId: "png", path: "assets/image.png" },
        { assetId: "svg", path: "assets/vector.svg" },
      ],
      scenes: Array.from({ length: count }, (_, index) => ({
        sceneId: `scene-${index}`,
        figmaNodeId: `root-${index}`,
        name: `Scene ${index}`,
        index,
        width: 8,
        height: 8,
        type: "FRAME",
        sceneTransform: identity,
        properties: {
          width: 8,
          height: 8,
          clipsContent: true,
          fills: [{ type: "SOLID", color: { r: changed ? 0 : 1, g: 0, b: 0 } }],
        },
        children: [],
        preview: `previews/${index}.png`,
      })),
    }),
  );
  for (let i = 0; i < count; i++) folder.file(`previews/${i}.png`, png);
  return zip.generateAsync({ type: "nodebuffer" });
}
test("pixel metrics respect transparency and count changed pixels", () => {
  assert.equal(
    comparePixels([1, 2, 3, 0], [9, 8, 7, 0]).metrics.changedPixels,
    0,
  );
  const result = comparePixels([255, 0, 0, 255], [0, 0, 0, 255]);
  assert.equal(result.metrics.changedPercent, 100);
  assert.equal(result.metrics.meanAbsoluteError, 85);
  assert.throws(() => comparePixels([0], [0]), /dimensions/);
});
test("local UI workflow: import 1/3/15 scenes, browse, edit notes, update, archive and validate all without stale files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "motion-workflow-"));
  const projects = path.join(root, "projects");
  await mkdir(projects);
  const server = await servePlatform(projects, 0);
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 8, height: 8 } });
    await page.setContent("<style>body{margin:0;background:red}</style>");
    const png = await page.screenshot();
    await page.setViewportSize({ width: 1280, height: 900 });
    const call = async (route: string, options?: RequestInit) => {
      const response = await fetch(base + route, options);
      const data = (await response.json()) as Record<string, any>;
      assert.ok(response.ok, JSON.stringify(data));
      return data;
    };
    const upload = async (
      count: number,
      name: string,
      projectId?: string,
      changed = false,
    ) =>
      call(
        "/api/import-preview?" +
          new URLSearchParams({ name, ...(projectId ? { projectId } : {}) }),
        {
          method: "POST",
          headers: { "Content-Type": "application/zip" },
          body: new Uint8Array(await exportZip(count, png, changed)),
        },
      );
    const commit = async (token: string) =>
      call("/api/import-commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
    const ids: string[] = [];
    for (const count of [1, 3, 15]) {
      const p = await upload(count, `Project ${count}`);
      assert.equal(p.sceneCount, count);
      ids.push((await commit(p.token)).projectId);
    }
    const list = await call("/api/projects");
    assert.equal(list.projects.length, 3);
    await page.goto(base);
    await page.waitForSelector("a.card");
    assert.equal(await page.locator("a.card").count(), 3);
    await page.locator("a.card").filter({ hasText: "Project 15" }).click();
    await page.waitForSelector("[data-scene-button]");
    assert.equal(await page.locator("#m-scenes option").count(), 15);
    assert.equal(await page.locator(".scene-thumb").count(), 15);
    await page
      .frameLocator(".scene-thumb")
      .first()
      .locator("svg")
      .waitFor({ state: "attached" });
    assert.equal(
      await page.locator("nav,#validate,#brief,#m-add,#m-block-json").count(),
      0,
    );
    await call("/api/projects/" + ids[2] + "/notes", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        brief: "USER BRIEF",
        scenes: (await call("/api/projects/" + ids[2])).notes.scenes,
      }),
    });
    const existing = await call("/api/projects/" + ids[2]);
    assert.equal(existing.notes.brief, "USER BRIEF");
    assert.equal((existing.notes.scenes.match(/## Scene/g) || []).length, 15);
    const projectPath = path.join(projects, "project-15");
    await writeFile(path.join(projectPath, "motion", "keep.txt"), "user");
    const preview = await upload(3, "Project 15", ids[2], true);
    assert.equal(preview.changes.previousScenes, 15);
    assert.equal(preview.changes.removed.length, 12);
    await commit(preview.token);
    assert.equal(
      (await call("/api/projects/" + ids[2])).notes.brief,
      "USER BRIEF",
    );
    assert.equal(
      await readFile(path.join(projectPath, "motion", "keep.txt"), "utf8"),
      "user",
    );
    assert.equal(
      (await readdir(path.join(projectPath, "history/imports"))).length,
      1,
    );
    const sourceHash = fingerprint(
      await inventory(path.join(projectPath, "source")),
    );
    async function validate(id: string) {
      const job = await call("/api/projects/" + id + "/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      for (let i = 0; i < 200; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const result = await call("/api/jobs/" + job.jobId);
        if (result.status !== "running") {
          assert.equal(result.status, "completed", result.error);
          return;
        }
      }
      throw new Error("Validation timeout");
    }
    await validate(ids[2]);
    let report = (await call("/api/projects/" + ids[2])).report;
    assert.equal(report.scenes.length, 3);
    assert.ok(
      report.scenes.every(
        (s: any) => s.difference && s.comparison.changedPercent === 100,
      ),
    );
    await writeFile(
      path.join(projectPath, "validation/differences/stale.png"),
      "old",
    );
    await validate(ids[2]);
    assert.ok(
      !(
        await readdir(path.join(projectPath, "validation/differences"))
      ).includes("stale.png"),
    );
    assert.equal(
      fingerprint(await inventory(path.join(projectPath, "source"))),
      sourceHash,
    );
    // All fifteen scenes, rather than a fixed three, must reconstruct and compare.
    const fifteen = await upload(15, "Fifteen");
    const id = (await commit(fifteen.token)).projectId;
    await validate(id);
    report = (await call("/api/projects/" + id)).report;
    assert.equal(report.scenes.length, 15);
    assert.ok(
      report.scenes.every((s: any) => s.comparison.changedPixels === 0),
    );
    await page.goto(base + "/#project/" + ids[2]);
    await page.reload();
    await page.waitForSelector("[data-scene-button]");
    assert.equal(await page.locator("#m-scenes option").count(), 3);
    await page.locator("[data-scene-button]").nth(2).click();
    await page.waitForFunction(
      () =>
        Number((document.querySelector("#m-frame") as HTMLInputElement).value) >
        0,
    );
    const motionFrame = page.frameLocator("#m-preview");
    await motionFrame
      .locator("[data-motion-scene]")
      .first()
      .waitFor({ state: "attached" });
    assert.equal(await motionFrame.locator("[data-motion-scene]").count(), 3);
    const before = (await readdir(projects)).filter((p) => !p.startsWith("."));
    const bad = await fetch(base + "/api/import-preview?name=Bad", {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: "bad zip",
    });
    assert.equal(bad.status, 400);
    assert.deepEqual(
      (await readdir(projects)).filter((p) => !p.startsWith(".")),
      before,
    );
    const foreign = await fetch(base + "/api/import-commit", {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(foreign.status, 400);
    // Exercise actual browser file upload and confirmation.
    const zipPath = path.join(root, "browser.zip");
    await writeFile(zipPath, await exportZip(1, png));
    await page.goto(base);
    await page
      .getByRole("button", { name: "+ НОВЫЙ ПРОЕКТ", exact: true })
      .click();
    await page.locator("#name").fill("Browser import");
    await page.locator("#zip").setInputFiles(zipPath);
    await page
      .getByRole("button", { name: "Проверить ZIP", exact: true })
      .click();
    await page.locator("#commit").waitFor({ state: "visible" });
    await page.locator("#commit").click();
    await page.waitForFunction(() => location.hash.startsWith("#project/"));
    await page.waitForSelector("[data-scene-button]");
    assert.equal(await page.locator("#m-scenes option").count(), 1);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});
