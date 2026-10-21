import { ensureRegistry } from "./registry.js";
import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
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
    lastCommit: z
      .object({
        transactionId: z.string().uuid(),
        revision: z.string(),
        previousRevision: z.string(),
        operationsDigest: z.string(),
        createdAt: z.string(),
      })
      .optional(),
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
  let doc: MotionDocument;
  let recoveredFromCorruption = false;
  try {
    await noSymlinkPath(project.root, file);
    const parsed = documentSchema.parse(JSON.parse(await readFile(file, "utf8")));
    if (parsed.cursor > parsed.history.length) {
      parsed.cursor = parsed.history.length;
      parsed.sourceDiagnostics = [
        "Повреждённый курсор истории motion был сброшен на последний коммит.",
      ];
    }
    doc = parsed;
  } catch {
    const bakFile = path.join(project.root, "motion/motion.json.bak");
    if (await exists(bakFile)) {
      try {
        await noSymlinkPath(project.root, bakFile);
        doc = documentSchema.parse(JSON.parse(await readFile(bakFile, "utf8")));
        recoveredFromCorruption = true;
      } catch {
        doc = {
          documentVersion: "1.0.0",
          revision: "initial",
          sourceFingerprint: project.inspection.fingerprint,
          state: defaultMotion(project),
          cursor: 0,
          history: [],
        };
        recoveredFromCorruption = true;
      }
    } else {
      doc = {
        documentVersion: "1.0.0",
        revision: "initial",
        sourceFingerprint: project.inspection.fingerprint,
        state: defaultMotion(project),
        cursor: 0,
        history: [],
      };
      recoveredFromCorruption = true;
    }
  }
  doc.sourceDiagnostics ??= [];
  if (recoveredFromCorruption) {
    doc.sourceDiagnostics.push(
      "Файл motion.json был повреждён или имел неверный формат. Загружен безопасный снимок состояния.",
    );
  }
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
    operationBatches?: unknown[];
    expectedCandidate?: MotionState;
    transactionId?: string;
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
    const batches = input.operationBatches?.map((b) =>
      operationsSchema.parse(b),
    );
    const operationsDigest = createHash("sha256")
      .update(JSON.stringify(batches ?? input.operations ?? input.action))
      .digest("hex");
    if (
      input.transactionId &&
      doc.lastCommit?.transactionId === input.transactionId
    ) {
      if (doc.lastCommit.operationsDigest !== operationsDigest)
        throw new Error("TRANSACTION_ID_REUSED_WITH_DIFFERENT_OPERATIONS");
      return { document: doc, diff: [], replayed: true };
    }
    if (input.expectedRevision !== doc.revision)
      throw Object.assign(
        new Error(
          "Анимация уже изменилась. Обновите страницу и повторите правку.",
        ),
        { code: "STALE_PROJECT_REVISION" },
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
      const operations = batches
        ? batches.flat()
        : operationsSchema.parse(input.operations);
      if (!operations.length) throw new Error("Нет операций для применения");
      for (const batch of batches ?? [operations])
        doc.state = applyOperations(doc.state, batch, project);
      if (
        input.expectedCandidate &&
        !isDeepStrictEqual(doc.state, input.expectedCandidate)
      )
        throw new Error("CANDIDATE_COMMIT_MISMATCH");
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
    const previousRevision = doc.revision;
    doc.revision = randomUUID();
    if (input.transactionId)
      doc.lastCommit = {
        transactionId: input.transactionId,
        previousRevision,
        revision: doc.revision,
        operationsDigest,
        createdAt: new Date().toISOString(),
      };
    else delete doc.lastCommit;
    doc.sourceFingerprint = project.inspection.fingerprint;
    delete doc.sourceDiagnostics;
    // Validate the persisted envelope too: aggregated batches must respect history limits.
    documentSchema.parse(doc);
    await safeDirectory(project.root, "motion");
    try {
      await atomicJson(path.join(project.root, "motion/motion.json"), doc, {
        durable: true,
      });
      await atomicJson(path.join(project.root, "motion/motion.json.bak"), doc, {
        durable: false,
      }).catch(() => {});
    } catch (error) {
      // A directory-sync failure after rename is not an uncommitted transaction.
      const persisted = documentSchema.parse(
        JSON.parse(
          await readFile(path.join(project.root, "motion/motion.json"), "utf8"),
        ),
      );
      if (!isDeepStrictEqual(persisted, doc)) throw error;
      return {
        document: doc,
        diff: motionDiff(before, doc.state),
        durabilityWarning: String(error),
      };
    }
    return { document: doc, diff: motionDiff(before, doc.state) };
  } finally {
    await unlock();
  }
}

/** Explicit maintenance, never automatic history deletion. Original document remains archived. */
export async function archiveMotionHistory(
  projectPath: string,
  expectedRevision: string,
  keepEntries = 100,
) {
  if (
    !Number.isSafeInteger(keepEntries) ||
    keepEntries < 1 ||
    keepEntries > 10000
  )
    throw new Error("Invalid history retention count");
  const unlock = await lockProject(projectPath);
  try {
    const project = await loadProject(projectPath),
      doc = await readMotion(project);
    if (doc.revision !== expectedRevision)
      throw new Error("STALE_PROJECT_REVISION");
    const drop = Math.max(0, doc.cursor - keepEntries);
    if (!drop)
      return {
        archived: false,
        revision: doc.revision,
        removedFromActiveHistory: 0,
      };
    const directory = await safeDirectory(
      project.root,
      "motion/history-archives",
    );
    const archive = path.join(directory, `${randomUUID()}.json`);
    await atomicJson(archive, doc, { durable: true });
    doc.history = doc.history.slice(drop);
    doc.cursor -= drop;
    doc.revision = randomUUID();
    delete doc.lastCommit;
    delete doc.sourceDiagnostics;
    documentSchema.parse(doc);
    await atomicJson(path.join(project.root, "motion/motion.json"), doc, {
      durable: true,
    });
    return {
      archived: true,
      revision: doc.revision,
      removedFromActiveHistory: drop,
      archive: path.relative(project.root, archive),
    };
  } finally {
    await unlock();
  }
}
