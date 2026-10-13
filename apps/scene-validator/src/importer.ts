import { validateMotion } from "./motion/operations.js";
import { buildRegistry } from "./motion/registry.js";
import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import type { Readable } from "node:stream";
import path from "node:path";
import JSZip from "jszip";
import {
  atomicJson,
  exists,
  fingerprint,
  inventory,
  lockProject,
  noSymlinkPath,
  relativePath,
  safeDirectory,
  within,
} from "./files.js";
import { inspectSource } from "./source.js";
import { readProject } from "./project.js";
import type { ProjectConfig, SourceInspection } from "./types.js";
export const slugify = (name: string): string =>
  name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
const MAX_IMPORT = 512 * 1024 * 1024;
export async function extractZip(
  source: string,
  target: string,
): Promise<string> {
  const size = (await lstat(source)).size;
  if (size > MAX_IMPORT) throw new Error("ZIP exceeds 512 MiB import limit");
  const zip = await JSZip.loadAsync(await readFile(source), {
    checkCRC32: false,
  });
  const entries = Object.values(zip.files);
  if (entries.length > 50000) throw new Error("ZIP contains too many files");
  const scenes = entries.filter(
    (e) =>
      !e.dir &&
      (e.name === "scene.json" || e.name.endsWith("/scene.json")) &&
      !e.name.startsWith("__MACOSX/"),
  );
  if (scenes.length !== 1)
    throw new Error("ZIP must contain exactly one scene.json export root");
  const root = scenes[0].name.slice(0, -"scene.json".length);
  let total = 0;
  const destinations = new Set<string>();
  for (const entry of entries) {
    const original = entry.unsafeOriginalName ?? entry.name;
    // JSZip sanitizes traversal names; verify original names as well.
    relativePath(original.replace(/\/$/, ""), "ZIP entry");
    const permissions =
      typeof entry.unixPermissions === "string"
        ? parseInt(entry.unixPermissions, 8)
        : entry.unixPermissions;
    if (
      permissions !== null &&
      permissions !== undefined &&
      (permissions & 0o170000) === 0o120000
    )
      throw new Error("ZIP symlinks are forbidden");
    if (
      entry.dir ||
      !entry.name.startsWith(root) ||
      entry.name.startsWith("__MACOSX/")
    )
      continue;
    const relative = relativePath(
      entry.name.slice(root.length),
      "ZIP resource",
    );
    if (destinations.has(relative))
      throw new Error("Duplicate ZIP destination");
    destinations.add(relative);
    // Stream decompression with a cap instead of allocating a ZIP bomb first.
    const chunks: Uint8Array[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = entry.nodeStream("nodebuffer") as Readable;
      stream.on("data", (chunk: Uint8Array) => {
        total += chunk.length;
        if (total > MAX_IMPORT) {
          stream.destroy(new Error("Expanded ZIP exceeds 512 MiB"));
          return;
        }
        chunks.push(chunk);
      });
      stream.on("error", reject);
      stream.on("end", resolve);
      stream.resume();
    });
    const output = within(target, relative);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, Buffer.concat(chunks), { flag: "wx" });
  }
  return target;
}
async function resolveExportFolder(source: string): Promise<string> {
  if (await exists(path.join(source, "scene.json"))) return source;
  if (await exists(path.join(source, "motion-project", "scene.json")))
    return path.join(source, "motion-project");
  throw new Error(
    "Export folder must contain scene.json, or motion-project/scene.json",
  );
}
export interface ImportOptions {
  name: string;
  source: string;
  projectsRoot: string;
  update?: boolean;
  projectPath?: string;
  expectedFingerprint?: string;
}
export interface ImportResult {
  projectPath: string;
  config: ProjectConfig;
  inspection: SourceInspection;
  updated: boolean;
  copyVerified: boolean;
}
export async function createProject(
  options: ImportOptions,
): Promise<ImportResult> {
  const slug = slugify(options.name);
  if (!slug) throw new Error("Project name must contain letters or numbers");
  const projectsRoot = path.resolve(options.projectsRoot);
  await mkdir(projectsRoot, { recursive: true });
  await inventoryEmptyRootCheck(projectsRoot);
  const destination = options.projectPath
    ? path.resolve(options.projectPath)
    : within(projectsRoot, slug);
  if (path.dirname(destination) !== projectsRoot)
    throw new Error("Project must be a direct child of projects root");
  const sourceInput = path.resolve(options.source);
  const stat = await lstat(sourceInput);
  if (stat.isSymbolicLink()) throw new Error("Source cannot be a symlink");
  const temporary = await mkdtemp(path.join(projectsRoot, ".motion-import-"));
  const staged = await mkdtemp(path.join(projectsRoot, ".import-stage-"));
  let unlock: (() => Promise<void>) | undefined;
  try {
    const source = stat.isDirectory()
      ? await resolveExportFolder(sourceInput)
      : await extractZip(sourceInput, path.join(temporary, "export"));
    if (
      source === destination ||
      source.startsWith(destination + path.sep) ||
      destination.startsWith(source + path.sep)
    )
      throw new Error(
        "Import source and destination must be independent directories",
      );
    const before = await inspectSource(source);
    await cp(source, path.join(staged, "source"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    const copied = await inspectSource(path.join(staged, "source"));
    const after = await inventory(source);
    if (
      before.fingerprint !== copied.fingerprint ||
      before.fingerprint !== fingerprint(after)
    )
      throw new Error(
        "Source changed during import or copy integrity check failed",
      );
    // Export report is optional in historical exports. Record absence explicitly.
    if (!(await exists(path.join(staged, "source", "export-report.json"))))
      await atomicJson(path.join(staged, "source", "export-report.json"), {
        exportedAt: null,
        errorCount: 0,
        warnings: [
          {
            code: "ORIGINAL_REPORT_MISSING",
            message: "Export did not include export-report.json",
          },
        ],
      });
    const inspection = await inspectSource(path.join(staged, "source"));
    const timestamp = new Date().toISOString();
    const importId = randomUUID();
    let config: ProjectConfig;
    const updated = await exists(destination);
    if (updated) {
      if (!options.update)
        throw new Error(
          `Project already exists: ${destination}. Use --update for a non-destructive reimport.`,
        );
      await noSymlinkPath(projectsRoot, destination);
      unlock = await lockProject(destination);
      const existing = await readProject(destination);
      if (
        options.expectedFingerprint &&
        options.expectedFingerprint !==
          fingerprint(await inventory(existing.sourceRoot))
      )
        throw new Error("Project changed since preview; upload again");
      if (existing.config.name !== options.name)
        throw new Error(
          "Name resolves to an existing different project. Choose a different name.",
        );
      config = {
        ...existing.config,
        source: {
          scene: "source/scene.json",
          exportReport: "source/export-report.json",
        },
        updatedAt: timestamp,
        imports: [
          ...existing.config.imports,
          {
            importId,
            importedAt: timestamp,
            sourceFingerprint: inspection.fingerprint,
            files: inspection.files.length,
          },
        ],
      };
    } else
      config = {
        schemaVersion: "1.0.0",
        projectId: randomUUID(),
        name: options.name,
        createdAt: timestamp,
        updatedAt: timestamp,
        source: {
          scene: "source/scene.json",
          exportReport: "source/export-report.json",
        },
        validation: { directory: "validation" },
        settings: { validationMode: "structural" },
        imports: [
          {
            importId,
            importedAt: timestamp,
            sourceFingerprint: inspection.fingerprint,
            files: inspection.files.length,
          },
        ],
      };
    await mkdir(path.join(staged, "motion"), { recursive: true });
    await atomicJson(
      path.join(staged, "motion/object-registry.json"),
      buildRegistry(inspection.document, inspection.fingerprint),
    );
    const referenceReport = {
      sourceFingerprint: inspection.fingerprint,
      diagnostics: [] as string[],
    };
    if (updated) {
      const motionFile = path.join(destination, "motion/motion.json");
      if (await exists(motionFile)) {
        await noSymlinkPath(destination, motionFile);
        try {
          const motion = JSON.parse(await readFile(motionFile, "utf8"));
          validateMotion(motion.state, {
            root: staged,
            config,
            inspection,
            sourceRoot: path.join(staged, "source"),
            scenePath: path.join(staged, "source/scene.json"),
          });
        } catch (error) {
          referenceReport.diagnostics.push(String(error));
        }
      }
    }
    await atomicJson(
      path.join(staged, "motion/source-reference-report.json"),
      referenceReport,
    );
    if (!updated) {
      for (const directory of [
        "notes",
        "validation/reconstructed",
        "validation/differences",
        "motion",
        "renders",
        "history/imports",
      ])
        await mkdir(path.join(staged, directory), { recursive: true });
      await writeFile(
        path.join(staged, "notes", "brief.md"),
        `# Project Brief

Project: ${options.name}
Resolution: ${[...new Set(inspection.document.scenes.map((s) => `${s.width}×${s.height}`))].join(", ")}
FPS:

## Description

## Notes
`,
      );
      await writeFile(
        path.join(staged, "notes", "scenes.md"),
        `# Storyboard

${inspection.document.scenes
  .map(
    (s, i) => `## Scene ${i + 1} — ${s.name}

`,
  )
  .join("")}`,
      );
      await atomicJson(path.join(staged, "project.json"), config);
      await rename(staged, destination);
    } else {
      // Retain the old source, metadata and validation as an import snapshot.
      const history = await safeDirectory(
        destination,
        `history/imports/${importId}`,
      );
      await cp(
        path.join(destination, "project.json"),
        path.join(history, "project.json"),
        { errorOnExist: true, force: false },
      );
      const registryFile = path.join(
        destination,
        "motion/object-registry.json",
      );
      await safeDirectory(destination, "motion");
      if (await exists(registryFile))
        await noSymlinkPath(destination, registryFile);
      const reportFile = path.join(
        destination,
        "motion/source-reference-report.json",
      );
      const hadReport = await exists(reportFile);
      if (hadReport) {
        await noSymlinkPath(destination, reportFile);
        await cp(
          reportFile,
          path.join(history, "source-reference-report.json"),
        );
      }
      const hadRegistry = await exists(registryFile);
      if (hadRegistry)
        await cp(registryFile, path.join(history, "object-registry.json"));
      let oldSource = false,
        newSource = false,
        oldValidation = false;
      try {
        await rename(
          path.join(destination, "source"),
          path.join(history, "source"),
        );
        oldSource = true;
        if (await exists(path.join(destination, "validation"))) {
          await rename(
            path.join(destination, "validation"),
            path.join(history, "validation"),
          );
          oldValidation = true;
        }
        await rename(
          path.join(staged, "source"),
          path.join(destination, "source"),
        );
        newSource = true;
        await mkdir(path.join(destination, "validation", "reconstructed"), {
          recursive: true,
        });
        await mkdir(path.join(destination, "validation", "differences"), {
          recursive: true,
        });
        await atomicJson(
          registryFile,
          buildRegistry(inspection.document, inspection.fingerprint),
        );
        await atomicJson(reportFile, referenceReport);
        await atomicJson(path.join(destination, "project.json"), config);
      } catch (error) {
        if (hadReport)
          await cp(
            path.join(history, "source-reference-report.json"),
            reportFile,
          );
        else await rm(reportFile, { force: true });
        if (hadRegistry)
          await cp(path.join(history, "object-registry.json"), registryFile);
        else await rm(registryFile, { force: true });
        if (newSource)
          await rm(path.join(destination, "source"), {
            recursive: true,
            force: true,
          });
        if (oldSource)
          await rename(
            path.join(history, "source"),
            path.join(destination, "source"),
          );
        if (newSource || oldValidation)
          await rm(path.join(destination, "validation"), {
            recursive: true,
            force: true,
          });
        if (oldValidation)
          await rename(
            path.join(history, "validation"),
            path.join(destination, "validation"),
          );
        throw error;
      }
    }
    return {
      projectPath: destination,
      config,
      inspection,
      updated,
      copyVerified: true,
    };
  } finally {
    if (unlock) await unlock();
    await rm(temporary, { recursive: true, force: true });
    await rm(staged, { recursive: true, force: true });
  }
}
async function inventoryEmptyRootCheck(root: string): Promise<void> {
  if ((await lstat(root)).isSymbolicLink())
    throw new Error("Projects root cannot be a symlink");
}
