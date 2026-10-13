import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { createProject } from "../src/importer.js";
import { inventory, fingerprint } from "../src/files.js";
import { loadProject } from "../src/project.js";
import { validateProject, reportHtml } from "../src/validation.js";
import { serveReport } from "../src/server.js";
import type { ValidationReport } from "../src/types.js";
async function fixture(scenes = 1) {
  const root = await mkdtemp(path.join(os.tmpdir(), "motion-test-"));
  const source = path.join(root, "export");
  await mkdir(path.join(source, "assets"), { recursive: true });
  await mkdir(path.join(source, "previews"));
  const document = {
    schemaVersion: "1.0.0",
    assets: [{ assetId: "asset-1", path: "assets/image.png", byteLength: 8 }],
    scenes: Array.from({ length: scenes }, (_, index) => ({
      sceneId: `scene-${index}`,
      figmaNodeId: `node-${index}`,
      name: `Scene ${index}`,
      index,
      width: 1920,
      height: 1080,
      children: [
        {
          figmaNodeId: `child-${index}`,
          parentId: `node-${index}`,
          children: [],
          properties: { fills: [{ assetId: "asset-1" }] },
        },
      ],
      preview: `previews/frame-${index}.png`,
    })),
  };
  await writeFile(path.join(source, "scene.json"), JSON.stringify(document));
  await writeFile(
    path.join(source, "export-report.json"),
    JSON.stringify({ errorCount: 0 }),
  );
  await writeFile(
    path.join(source, "assets", "image.png"),
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  for (let i = 0; i < scenes; i++)
    await writeFile(
      path.join(source, "previews", `frame-${i}.png`),
      "REFERENCE_ONLY",
    );
  return {
    root,
    source,
    projectsRoot: path.join(root, "projects"),
    document,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
test("folder import is autonomous, preserves scene IDs and verifies byte-for-byte copy", async () => {
  const f = await fixture(16);
  try {
    const before = fingerprint(await inventory(f.source));
    const result = await createProject({
      name: "Red Collar Promo",
      source: f.source,
      projectsRoot: f.projectsRoot,
    });
    const loaded = await loadProject(result.projectPath);
    assert.equal(loaded.inspection.document.scenes.length, 16);
    assert.equal(loaded.inspection.document.scenes[15].sceneId, "scene-15");
    assert.equal(loaded.inspection.fingerprint, before);
    assert.equal(fingerprint(await inventory(f.source)), before);
    assert.equal(result.copyVerified, true);
    assert.equal(result.config.source.scene, "source/scene.json");
    await rm(f.source, { recursive: true });
    assert.equal(
      (await loadProject(result.projectPath)).inspection.document.assets.length,
      1,
    );
  } finally {
    await f.cleanup();
  }
});
test("two independent projects share the same application; validation is isolated and source immutable", async () => {
  const f = await fixture(4);
  try {
    const a = await createProject({
      name: "A",
      source: f.source,
      projectsRoot: f.projectsRoot,
    });
    const b = await createProject({
      name: "B",
      source: f.source,
      projectsRoot: f.projectsRoot,
    });
    assert.notEqual(a.config.projectId, b.config.projectId);
    const before = fingerprint(
      await inventory(path.join(a.projectPath, "source")),
    );
    const report = await validateProject(a.projectPath);
    assert.equal(report.sceneCount, 4);
    assert.equal(report.reconstruction, "not-requested");
    assert.equal(report.visualComparison, "not-performed");
    assert.equal(
      fingerprint(await inventory(path.join(a.projectPath, "source"))),
      before,
    );
    assert.deepEqual(await readdir(path.join(b.projectPath, "validation")), [
      "differences",
      "reconstructed",
    ]);
    assert.equal(
      (await readdir(path.join(a.projectPath, "validation", "reconstructed")))
        .length,
      0,
    );
  } finally {
    await f.cleanup();
  }
});
test("rerun replaces results including stale reconstructed/difference files", async () => {
  const f = await fixture();
  try {
    const p = await createProject({
      name: "A",
      source: f.source,
      projectsRoot: f.projectsRoot,
    });
    const first = await validateProject(p.projectPath);
    await writeFile(
      path.join(p.projectPath, "validation", "reconstructed", "old.png"),
      "old",
    );
    await writeFile(
      path.join(p.projectPath, "validation", "differences", "old.png"),
      "old",
    );
    await writeFile(
      path.join(p.projectPath, "validation", "obsolete.html"),
      "old",
    );
    const second = await validateProject(p.projectPath);
    assert.notEqual(first.runId, second.runId);
    assert.deepEqual(await readdir(path.join(p.projectPath, "validation")), [
      "differences",
      "reconstructed",
      "report.html",
      "report.json",
    ]);
    assert.deepEqual(
      await readdir(path.join(p.projectPath, "validation", "reconstructed")),
      [],
    );
    assert.deepEqual(
      await readdir(path.join(p.projectPath, "validation", "differences")),
      [],
    );
  } finally {
    await f.cleanup();
  }
});
test("reimport preserves project identity, notes, motion, renders and prior source/history", async () => {
  const f = await fixture();
  try {
    const p = await createProject({
      name: "A",
      source: f.source,
      projectsRoot: f.projectsRoot,
    });
    await validateProject(p.projectPath);
    for (const relative of [
      "notes/brief.md",
      "notes/scenes.md",
      "motion/user.json",
      "renders/user.mp4",
      "history/user.txt",
    ])
      await writeFile(path.join(p.projectPath, relative), "USER_CONTENT");
    await assert.rejects(
      () =>
        createProject({
          name: "A",
          source: f.source,
          projectsRoot: f.projectsRoot,
        }),
      /already exists/,
    );
    f.document.scenes[0].name = "New scene name";
    await writeFile(
      path.join(f.source, "scene.json"),
      JSON.stringify(f.document),
    );
    const updated = await createProject({
      name: "A",
      source: f.source,
      projectsRoot: f.projectsRoot,
      update: true,
    });
    assert.equal(updated.config.projectId, p.config.projectId);
    assert.equal(updated.config.imports.length, 2);
    for (const relative of [
      "notes/brief.md",
      "notes/scenes.md",
      "motion/user.json",
      "renders/user.mp4",
      "history/user.txt",
    ])
      assert.equal(
        await readFile(path.join(p.projectPath, relative), "utf8"),
        "USER_CONTENT",
      );
    const history = path.join(
      p.projectPath,
      "history",
      "imports",
      updated.config.imports[1].importId,
    );
    assert.ok(await readFile(path.join(history, "validation", "report.html")));
    assert.equal(
      JSON.parse(
        await readFile(path.join(history, "source", "scene.json"), "utf8"),
      ).scenes[0].name,
      "Scene 0",
    );
    assert.equal(
      (await loadProject(p.projectPath)).inspection.document.scenes[0].name,
      "New scene name",
    );
    assert.deepEqual(await readdir(path.join(p.projectPath, "validation")), [
      "differences",
      "reconstructed",
    ]);
  } finally {
    await f.cleanup();
  }
});
test("ZIP and parent unpacked folder import preserve files", async () => {
  const f = await fixture(2);
  try {
    const zip = new JSZip();
    for (const file of await inventory(f.source))
      zip.file(
        "motion-project/" + file.path,
        await readFile(path.join(f.source, file.path)),
      );
    const zipPath = path.join(f.root, "export.zip");
    await writeFile(zipPath, await zip.generateAsync({ type: "nodebuffer" }));
    const zipped = await createProject({
      name: "ZIP",
      source: zipPath,
      projectsRoot: f.projectsRoot,
    });
    assert.equal(zipped.inspection.document.scenes.length, 2);
    assert.equal(
      zipped.inspection.fingerprint,
      fingerprint(await inventory(f.source)),
    );
    const parent = path.join(f.root, "unpacked");
    await mkdir(parent);
    const { cp } = await import("node:fs/promises");
    await cp(f.source, path.join(parent, "motion-project"), {
      recursive: true,
    });
    const unpacked = await createProject({
      name: "Folder",
      source: parent,
      projectsRoot: f.projectsRoot,
    });
    assert.equal(
      unpacked.inspection.fingerprint,
      zipped.inspection.fingerprint,
    );
  } finally {
    await f.cleanup();
  }
});
for (const scenario of [
  "invalid-json",
  "missing-scene",
  "missing-asset",
  "traversal",
  "absolute",
  "duplicate-scene",
  "unresolved-reference",
  "parent-mismatch",
] as const)
  test(`rejects invalid import: ${scenario}`, async () => {
    const f = await fixture();
    try {
      const scenePath = path.join(f.source, "scene.json");
      if (scenario === "invalid-json") await writeFile(scenePath, "{broken");
      else if (scenario === "missing-scene") await rm(scenePath);
      else if (scenario === "missing-asset")
        await rm(path.join(f.source, "assets", "image.png"));
      else {
        if (scenario === "traversal")
          f.document.assets[0].path = "../outside.png";
        if (scenario === "absolute")
          f.document.assets[0].path = "/tmp/outside.png";
        if (scenario === "duplicate-scene")
          f.document.scenes.push({ ...f.document.scenes[0], index: 1 });
        if (scenario === "unresolved-reference")
          f.document.scenes[0].children[0].properties.fills[0].assetId =
            "not-present";
        if (scenario === "parent-mismatch")
          f.document.scenes[0].children[0].parentId = "wrong";
        await writeFile(scenePath, JSON.stringify(f.document));
      }
      await assert.rejects(() =>
        createProject({
          name: "Invalid",
          source: f.source,
          projectsRoot: f.projectsRoot,
        }),
      );
      assert.deepEqual(await readdir(f.projectsRoot), []);
    } finally {
      await f.cleanup();
    }
  });
test("asset symlinks and unsafe original ZIP paths are rejected", async () => {
  const f = await fixture();
  try {
    await symlink(
      path.join(f.source, "scene.json"),
      path.join(f.source, "assets", "linked.json"),
    );
    await assert.rejects(
      () =>
        createProject({
          name: "Link",
          source: f.source,
          projectsRoot: f.projectsRoot,
        }),
      /Symlinks/,
    );
    await rm(path.join(f.source, "assets", "linked.json"));
    const zip = new JSZip();
    zip.file("motion-project/scene.json", JSON.stringify(f.document));
    zip.file("../outside.txt", "evil");
    const zipPath = path.join(f.root, "unsafe.zip");
    await writeFile(zipPath, await zip.generateAsync({ type: "nodebuffer" }));
    await assert.rejects(
      () =>
        createProject({
          name: "ZIP",
          source: zipPath,
          projectsRoot: f.projectsRoot,
        }),
      /safe relative path/,
    );
  } finally {
    await f.cleanup();
  }
});
test("failed validation replaces stale success with failure report without editing source", async () => {
  const f = await fixture();
  try {
    const p = await createProject({
      name: "A",
      source: f.source,
      projectsRoot: f.projectsRoot,
    });
    await validateProject(p.projectPath);
    await rm(path.join(p.projectPath, "source", "assets", "image.png"));
    const before = fingerprint(
      await inventory(path.join(p.projectPath, "source")),
    );
    const failed = await validateProject(p.projectPath);
    assert.equal(failed.status, "failed");
    assert.match(failed.errors.join(" "), /Missing asset/);
    assert.equal(
      fingerprint(await inventory(path.join(p.projectPath, "source"))),
      before,
    );
  } finally {
    await f.cleanup();
  }
});
test("project config follows relative scene location; prevents output into source", async () => {
  const f = await fixture();
  try {
    const p = await createProject({
      name: "A",
      source: f.source,
      projectsRoot: f.projectsRoot,
    });
    const { rename } = await import("node:fs/promises");
    await rename(
      path.join(p.projectPath, "source", "scene.json"),
      path.join(p.projectPath, "source", "layout.json"),
    );
    p.config.source.scene = "source/layout.json";
    await writeFile(
      path.join(p.projectPath, "project.json"),
      JSON.stringify(p.config),
    );
    assert.equal(
      (await loadProject(p.projectPath)).inspection.document.scenes.length,
      1,
    );
    const bad = { ...p.config, validation: { directory: "source" } };
    await writeFile(
      path.join(p.projectPath, "project.json"),
      JSON.stringify(bad),
    );
    await assert.rejects(
      () => validateProject(p.projectPath),
      /Validation output/,
    );
  } finally {
    await f.cleanup();
  }
});
test("HTML escapes user labels and does not use Figma previews as reconstructed images", () => {
  const report = {
    projectName: "<script>attack</script>",
    projectId: "id",
    runId: "run",
    validatedAt: "date",
    status: "passed",
    sceneCount: 1,
    assetCount: 0,
    nodeCount: 1,
    scenes: [{ sceneId: "id", name: "<img src=x>", width: 1, height: 1 }],
    errors: [],
    warnings: [],
  } as unknown as ValidationReport;
  const html = reportHtml(report);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("Визуальное сравнение не выполнялось"));
});
test("dev server serves only reports from chosen project and blocks arbitrary/source routes", async () => {
  const f = await fixture();
  try {
    const p = await createProject({
      name: "Server",
      source: f.source,
      projectsRoot: f.projectsRoot,
    });
    await validateProject(p.projectPath);
    const server = await serveReport(p.projectPath, 0);
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const base = `http://127.0.0.1:${address.port}`;
      assert.equal((await fetch(base + "/")).status, 200);
      assert.equal((await fetch(base + "/report.json")).status, 200);
      assert.equal((await fetch(base + "/source/scene.json")).status, 404);
      assert.equal((await fetch(base + "/../../project.json")).status, 404);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  } finally {
    await f.cleanup();
  }
});

test("failed reimport leaves existing source, notes and config untouched", async () => {
  const f = await fixture();
  try {
    const p = await createProject({
      name: "A",
      source: f.source,
      projectsRoot: f.projectsRoot,
    });
    await writeFile(path.join(p.projectPath, "notes", "brief.md"), "KEEP");
    const before = fingerprint(
      await inventory(path.join(p.projectPath, "source")),
    );
    const config = await readFile(
      path.join(p.projectPath, "project.json"),
      "utf8",
    );
    await writeFile(path.join(f.source, "scene.json"), "{bad");
    await assert.rejects(() =>
      createProject({
        name: "A",
        source: f.source,
        projectsRoot: f.projectsRoot,
        update: true,
      }),
    );
    assert.equal(
      fingerprint(await inventory(path.join(p.projectPath, "source"))),
      before,
    );
    assert.equal(
      await readFile(path.join(p.projectPath, "notes", "brief.md"), "utf8"),
      "KEEP",
    );
    assert.equal(
      await readFile(path.join(p.projectPath, "project.json"), "utf8"),
      config,
    );
  } finally {
    await f.cleanup();
  }
});
test("project lock blocks simultaneous writes and does not leave staging files", async () => {
  const f = await fixture();
  try {
    const p = await createProject({
      name: "A",
      source: f.source,
      projectsRoot: f.projectsRoot,
    });
    await mkdir(path.join(p.projectPath, ".project-lock"));
    await assert.rejects(
      () => validateProject(p.projectPath),
      /Project is busy/,
    );
    await rm(path.join(p.projectPath, ".project-lock"), { recursive: true });
    assert.equal((await validateProject(p.projectPath)).status, "passed");
    assert.ok(
      !(await readdir(p.projectPath)).some((p) =>
        p.startsWith(".validation-stage-"),
      ),
    );
  } finally {
    await f.cleanup();
  }
});
test("history symlinks cannot redirect reimport writes outside the project", async () => {
  const f = await fixture();
  try {
    const p = await createProject({
      name: "A",
      source: f.source,
      projectsRoot: f.projectsRoot,
    });
    const before = fingerprint(
      await inventory(path.join(p.projectPath, "source")),
    );
    await rm(path.join(p.projectPath, "history"), { recursive: true });
    await symlink(f.source, path.join(p.projectPath, "history"));
    await assert.rejects(
      () =>
        createProject({
          name: "A",
          source: f.source,
          projectsRoot: f.projectsRoot,
          update: true,
        }),
      /Unsafe output directory/,
    );
    assert.equal(
      fingerprint(await inventory(path.join(p.projectPath, "source"))),
      before,
    );
    assert.ok(!(await readdir(f.source)).includes("imports"));
  } finally {
    await f.cleanup();
  }
});
