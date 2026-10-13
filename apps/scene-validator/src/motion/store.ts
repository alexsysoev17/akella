import { ensureRegistry } from "./registry.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  atomicJson,
  exists,
  lockProject,
  noSymlinkPath,
  safeDirectory,
} from "../files.js";
import { loadProject } from "../project.js";
import type { LoadedProject } from "../types.js";
import { defaultMotion } from "./context.js";
import { motionSchema, operationsSchema, type MotionState } from "./schema.js";
import { applyOperations, motionDiff, validateMotion } from "./operations.js";
const entry = z
  .object({
    editId: z.string(),
    createdAt: z.string(),
    request: z.string(),
    origin: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    assumptions: z.array(z.string().max(2000)).max(60).default([]),
    warnings: z.array(z.string().max(2000)).max(50).default([]),
    operations: operationsSchema,
    before: motionSchema,
    after: motionSchema,
  })
  .strict();
const documentSchema = z
  .object({
    documentVersion: z.literal("1.0.0"),
    revision: z.string(),
    sourceFingerprint: z.string(),
    state: motionSchema,
    cursor: z.number().int().min(0),
    history: z.array(entry),
    sourceDiagnostics: z.array(z.string()).optional(),
  })
  .strict();
export type MotionDocument = z.infer<typeof documentSchema>;
export async function readMotion(
  project: LoadedProject,
): Promise<MotionDocument> {
  await ensureRegistry(project);
  const file = path.join(project.root, "motion/motion.json");
  if (!(await exists(file)))
    return {
      documentVersion: "1.0.0",
      revision: "initial",
      sourceFingerprint: project.inspection.fingerprint,
      state: defaultMotion(project),
      cursor: 0,
      history: [],
    };
  await noSymlinkPath(project.root, file);
  const doc = documentSchema.parse(JSON.parse(await readFile(file, "utf8")));
  if (doc.cursor > doc.history.length)
    throw new Error("Повреждён курсор истории motion");
  doc.sourceDiagnostics = [];
  try {
    validateMotion(doc.state, project);
  } catch (error) {
    doc.sourceDiagnostics.push(String(error));
  }
  if (doc.sourceFingerprint !== project.inspection.fingerprint)
    doc.sourceDiagnostics.push(
      "Исходный дизайн обновлён. Ссылки проверены; сохранённые операции и история не переназначены.",
    );
  const reportFile = path.join(
    project.root,
    "motion/source-reference-report.json",
  );
  if (await exists(reportFile)) await noSymlinkPath(project.root, reportFile);
  const report = {
    sourceFingerprint: project.inspection.fingerprint,
    revision: doc.revision,
    diagnostics: doc.sourceDiagnostics,
  };
  if (
    !(await exists(reportFile)) ||
    JSON.stringify(JSON.parse(await readFile(reportFile, "utf8"))) !==
      JSON.stringify(report)
  )
    await atomicJson(reportFile, report);
  return doc;
}
export async function changeMotion(
  projectPath: string,
  input: {
    expectedRevision: string;
    expectedSourceFingerprint?: string;
    operations?: unknown;
    action?: "undo" | "redo";
    request: string;
    origin?: z.infer<typeof entry>["origin"];
    assumptions?: string[];
    warnings?: string[];
  },
) {
  const unlock = await lockProject(projectPath);
  try {
    const project = await loadProject(projectPath),
      doc = await readMotion(project);
    if (
      input.expectedSourceFingerprint &&
      project.inspection.fingerprint !== input.expectedSourceFingerprint
    )
      throw new Error("Исходный дизайн изменился во время выполнения задачи");
    if (input.expectedRevision !== doc.revision)
      throw new Error(
        "Анимация уже изменилась. Обновите страницу и повторите правку.",
      );
    const before = structuredClone(doc.state);
    if (input.action) {
      if (input.action === "undo") {
        if (!doc.cursor) throw new Error("Нет изменений для отмены");
        doc.state = doc.history[--doc.cursor].before;
      } else {
        if (doc.cursor >= doc.history.length)
          throw new Error("Нет изменений для повтора");
        doc.state = doc.history[doc.cursor++].after;
      }
    } else {
      const operations = operationsSchema.parse(input.operations);
      if (!operations.length) throw new Error("Нет операций для применения");
      doc.state = applyOperations(doc.state, operations, project);
      doc.history = doc.history.slice(0, doc.cursor);
      doc.history.push({
        editId: randomUUID(),
        createdAt: new Date().toISOString(),
        request: input.request.slice(0, 20000),
        origin: input.origin ?? "manual",
        assumptions: input.assumptions ?? [],
        warnings: input.warnings ?? [],
        operations,
        before,
        after: structuredClone(doc.state),
      });
      doc.cursor = doc.history.length;
    }
    validateMotion(doc.state, project);
    doc.revision = randomUUID();
    doc.sourceFingerprint = project.inspection.fingerprint;
    delete doc.sourceDiagnostics;
    await safeDirectory(project.root, "motion");
    await atomicJson(path.join(project.root, "motion/motion.json"), doc);
    return { document: doc, diff: motionDiff(before, doc.state) };
  } finally {
    await unlock();
  }
}
