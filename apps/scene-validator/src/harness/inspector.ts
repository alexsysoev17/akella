import path from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import JSZip from "jszip";
import { z } from "zod";
import { within, noSymlinkPath } from "../files.js";
import { motionDiff } from "../motion/operations.js";
import type { MotionState } from "../motion/schema.js";
import { redact } from "./security.js";
const LIMIT = 4 * 1024 * 1024;
type Data = Record<string, unknown>;
async function saved(root: string, relative: string): Promise<unknown> {
  const file = within(root, relative);
  try {
    await noSymlinkPath(root, file);
    if ((await stat(file)).size > LIMIT)
      return { status: "NOT_AVAILABLE", reason: "FILE_SIZE_LIMIT" };
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "NOT_AVAILABLE";
    throw e;
  }
}
/** Diagnostics are bounded projections. Never evaluate motion or invoke a provider. */
export function debugSafe(value: unknown, depth = 0): unknown {
  if (depth > 20) return "[DEPTH_LIMIT]";
  if (typeof value === "string")
    return value
      .replace(/\/Users\/[^/\s]+/g, "/Users/[USER]")
      .replace(/data:[^\s]+;base64,[A-Za-z0-9+/=]+/g, "[BINARY_OMITTED]")
      .slice(0, 6000);
  if (Array.isArray(value))
    return value.slice(0, 500).map((v) => debugSafe(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 300)
        .map(([k, v]) => [
          k,
          /^(reasoning|chainOfThought|geometry|svg|base64|password|cookie|credentials|secret|.*token|apiKey|authorization)$/i.test(
            k,
          )
            ? "[OMITTED]"
            : debugSafe(v, depth + 1),
        ]),
    );
  return value;
}
const clean = (v: unknown) => debugSafe(redact(v));
const summaries = new Map<string, { mtime: number; row: unknown }>();
export async function inspectorRuns(root: string) {
  const dir = within(root, "motion/harness/runs");
  let ids: string[];
  try {
    await noSymlinkPath(root, dir);
    ids = (await readdir(dir)).filter((id) => z.uuid().safeParse(id).success);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const ordered = await Promise.all(
    ids.map(async (id) => {
      const p = within(root, `motion/harness/runs/${id}`);
      await noSymlinkPath(root, p);
      const f = path.join(p, "run.json");
      await noSymlinkPath(root, f);
      return { id, time: (await stat(f)).mtimeMs };
    }),
  );
  const rows = [];
  for (const { id, time } of ordered
    .sort((a, b) => b.time - a.time)
    .slice(0, 100)) {
    const key = root + "/" + id,
      cache = summaries.get(key);
    if (cache?.mtime === time) {
      rows.push(cache.row);
      continue;
    }
    const run = (await saved(
      root,
      `motion/harness/runs/${id}/run.json`,
    )) as Data;
    const row = clean({
      runId: id,
      createdAt: run.createdAt,
      status: run.status,
      calls: run.calls,
      metrics: run.metrics,
    });
    if (summaries.size >= 200) summaries.delete(summaries.keys().next().value!);
    summaries.set(key, { mtime: time, row });
    rows.push(row);
  }
  return rows;
}
export async function inspectorRun(root: string, id: string, raw = false) {
  z.uuid().parse(id);
  const base = `motion/harness/runs/${id}`;
  const run = (await saved(root, `${base}/run.json`)) as Data;
  if (!run || typeof run !== "object" || !run.runId)
    throw new Error("Agent Run not found");
  const full = run.privacy === "full";
  const trace = await saved(root, `${base}/trace.json`);
  const tasks = full
    ? await saved(root, `motion/ai/${id}/tasks.json`)
    : "NOT_AVAILABLE";
  const requestFile = full
    ? await saved(root, `motion/ai/${id}/request.json`)
    : "NOT_AVAILABLE";
  const request =
    requestFile === "NOT_AVAILABLE" && Array.isArray(trace)
      ? (trace.find((e) => e.stage === "received")?.data ?? "NOT_AVAILABLE")
      : requestFile;
  const doc = full ? ((await saved(root, "motion/motion.json")) as Data) : {};
  const history = Array.isArray(doc.history)
    ? doc.history.filter(
        (h: Data) =>
          typeof h.request === "string" && h.request.startsWith(`[${id}/`),
      )
    : [];
  const qa: unknown[] = [];
  const qaDir = within(root, `motion/qa/${id}`);
  let attempts: string[] = [];
  if (full) {
    try {
      await noSymlinkPath(root, qaDir);
      attempts = await readdir(qaDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  for (const attempt of attempts
    .filter((a) =>
      /^(task_[a-f0-9]{16}-attempt-\d+|attempt-\d+|manual)$/.test(a),
    )
    .slice(0, 20)) {
    const report = await saved(root, `motion/qa/${id}/${attempt}/report.json`);
    const dir = within(root, `motion/qa/${id}/${attempt}`);
    await noSymlinkPath(root, dir);
    const frames = (await readdir(dir))
      .filter((f) => /^(contact-sheet|frame-\d+)\.png$/.test(f))
      .slice(0, 16);
    qa.push({ attempt, report, frames, categories: qaCategories(report) });
  }
  const changes = history.slice(-80).map((h: Data) => ({
    editId: h.editId,
    createdAt: h.createdAt,
    operations: h.operations,
    diff:
      h.before && h.after
        ? motionDiff(h.before as MotionState, h.after as MotionState)
        : "NOT_AVAILABLE",
    ...(raw ? { before: h.before, after: h.after } : {}),
  }));
  const sources: Data = {};
  if (raw && full)
    for (const file of [
      "context.json",
      "proposal.json",
      "execution.json",
      "error.json",
      "intent-draft-1.json",
      "intent-audit-1.json",
      "intent-contract.json",
      "semantic-interpret/raw-response.json",
      "semantic-interpret/provider-trace.json",
      "attempt-1.json",
      "attempt-2.json",
      "attempt-3.json",
    ])
      sources[file] = await saved(root, `motion/ai/${id}/${file}`);
  if (raw && full && tasks && typeof tasks === "object")
    for (const task of ((tasks as { tasks?: Data[] }).tasks ?? []).slice(
      0,
      15,
    )) {
      if (
        typeof task.taskId !== "string" ||
        !/^task_[a-f0-9]{16}$/.test(task.taskId)
      )
        continue;
      for (const attempt of [1, 2, 3])
        for (const file of ["raw-response.json", "provider-trace.json"]) {
          const relative = `${task.taskId}/attempt-${attempt}/${file}`;
          sources[relative] = await saved(root, `motion/ai/${id}/${relative}`);
        }
    }
  const repairComparisons =
    tasks && typeof tasks === "object"
      ? ((tasks as { tasks?: Data[] }).tasks ?? []).map((task) => {
          let previous: unknown;
          const attempts = (
            Array.isArray(task.repairHistory) ? task.repairHistory : []
          ).map((entry: Data) => {
            const feedback = entry.feedback as Data | undefined;
            const operations = entry.operations ?? feedback?.actualOperations;
            const changed =
              previous !== undefined && operations !== undefined
                ? JSON.stringify(previous) !== JSON.stringify(operations)
                : "NOT_AVAILABLE";
            const result = {
              attempt: entry.attempt,
              changedOperations: changed,
              previousOperations: previous ?? "NOT_AVAILABLE",
              operations: operations ?? "NOT_AVAILABLE",
              failureReason:
                feedback?.failureReason ?? entry.error ?? "NOT_AVAILABLE",
              validation: entry.validation,
              qa: entry.qa,
            };
            if (operations !== undefined) previous = operations;
            return result;
          });
          return { taskId: task.taskId, attempts };
        })
      : "NOT_AVAILABLE";
  const received = Array.isArray(trace)
    ? trace.find((e) => e.stage === "received")?.data
    : undefined;
  const view = clean({
    run: raw ? run : { ...run, result: undefined },
    trace,
    request,
    understanding: tasks,
    stateChanges: changes,
    stateChangeAvailability:
      typeof doc === "object" && Array.isArray(doc.history)
        ? "AVAILABLE"
        : "NOT_AVAILABLE",
    qa,
    qaAvailability: attempts.length > 20 ? "PARTIAL: QA_ATTEMPT_LIMIT" : qa.length ? "AVAILABLE" : "NOT_TESTED",
    rawSources: raw ? sources : undefined,
    artisticQA: "NOT_TESTED",
    missingData: "NOT_AVAILABLE",
    evaluator: evaluatorDetails([
      ...changes,
      ...(tasks && typeof tasks === "object"
        ? ((tasks as { tasks?: Data[] }).tasks ?? []).map((t) => ({
            operations: t.generatedOperations,
          }))
        : []),
    ]),
    coverage: run.outcome,
    repairComparisons,
    prompt:
      typeof received?.request === "string"
        ? received.request
        : ((request as Data)?.request ?? "NOT_AVAILABLE"),
  }) as Data;
  const omitted: string[] = [];
  for (const key of [
    "rawSources",
    "trace",
    "stateChanges",
    "qa",
    "understanding",
    "repairComparisons",
    "run",
  ]) {
    if (Buffer.byteLength(JSON.stringify(view)) <= 2 * 1024 * 1024) break;
    omitted.push(key);
    view[key] =
      key === "qa" || key === "stateChanges"
        ? []
        : key === "run"
          ? {
              runId: run.runId,
              status: run.status,
              createdAt: run.createdAt,
              privacy: run.privacy,
            }
          : "NOT_AVAILABLE: RESPONSE_SIZE_LIMIT";
  }
  if (omitted.length) view.omittedSections = omitted;
  return view;
}
export function qaCategories(report: unknown): Record<string, unknown> {
  const checks =
    report &&
    typeof report === "object" &&
    Array.isArray((report as Data).checks)
      ? (report as { checks: Data[] }).checks
      : [];
  const groups: Record<string, Data[]> = {
    technical: [],
    mathematics: [],
    render: [],
    visual: [],
  };
  for (const check of checks) {
    const name = String(check.name);
    const group =
      /render|MASK|GLYPH|CLIP|FINAL_STATE|GRADIENT|PATH_REVEAL|TRANSFORM_INTEGRITY/i.test(
        name,
      )
        ? "render"
        : /oscillation|frequency|decay|sampling|continuous|velocity|finite|revealParameters/i.test(
              name,
            )
          ? "mathematics"
          : "technical";
    groups[group].push(check);
  }
  return {
    ...Object.fromEntries(
      Object.entries(groups).map(([k, v]) => [k, v.length ? v : "NOT_TESTED"]),
    ),
    artistic: "NOT_TESTED",
  };
}
function evaluatorDetails(changes: { operations: unknown }[]) {
  const text = JSON.stringify(changes);
  if (!text.includes("inertialOvershoot")) return "NOT_AVAILABLE";
  const effects: Data[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (v && typeof v === "object") {
      const d = v as Data;
      if (d.type === "inertialOvershoot") effects.push(d);
      else Object.values(d).forEach(visit);
    }
  };
  changes.forEach((c) => visit(c.operations));
  return {
    effects: effects.map((e) => ({
      ...e,
      algorithmVersion:
        (e.parameters as Data)?.mode === "ae"
          ? "core incoming derivative"
          : "legacy compatibility",
    })),
    technique: "inertialOvershoot",
    dispatcher: "apps/scene-validator/src/motion/expressions.ts",
    implementation:
      "apps/scene-validator/src/motion-library/expressions/functions.ts",
    sampling: "apps/scene-validator/src/motion/sampling.ts",
    algorithms: {
      ae: "Modern: base animation derivative at last key time minus 1/(FPS*10)",
      legacy: "Saved legacy: averaged lookback velocity",
    },
    selectedAlgorithm:
      "Inspect persisted effect parameters; missing mode retains legacy compatibility. Numerical input velocity: only available if saved in QA samples.",
  };
}
export function debugReport(data: Data) {
  const run = data.run as Data,
    understanding = data.understanding as Data;
  const requirements = Array.isArray(
    understanding?.contract && (understanding.contract as Data).requirements,
  )
    ? (understanding.contract as { requirements: Data[] }).requirements
    : [];
  const tasks = Array.isArray(understanding?.tasks)
    ? (understanding.tasks as Data[])
    : [];
  const lines = [
    "# Motion Agent Debug Report",
    `Run: ${run.runId}`,
    `Status: ${run.status}`,
    `Created: ${run.createdAt}`,
    "",
    "## User Prompt",
    String(data.prompt),
    "",
    "## Provider",
    pretty(run.calls),
    "",
    "## Final Reconciliation",
    pretty(run.outcome),
    "",
    "## Understanding / Object Resolution",
  ];
  for (const r of requirements)
    lines.push(
      `- ${r.requirementId}: ${r.status ?? "NOT_AVAILABLE"} — ${pretty(r.target)}; scene=${r.sceneId}; techniques=${pretty(r.techniques)}; timing=${pretty(r.timing)}; dependencies=${pretty(r.dependencies)}; inheritance=${pretty(r.inheritFromRequirementId)}; source=${r.sourceText}; error=${r.error ?? "none"}`,
    );
  if (!requirements.length) lines.push("NOT_AVAILABLE");
  lines.push("", "## Tasks / Operations / Repair");
  for (const t of tasks)
    lines.push(
      pretty({
        taskId: t.taskId,
        target: t.targetReference,
        techniques: t.techniques,
        status: t.status,
        error: t.error,
        operations: t.generatedOperations,
        validation: t.validationResult,
        repair: t.repairHistory,
      }),
    );
  lines.push("", "## Applied Changes", pretty(data.stateChanges), "", "## QA");
  for (const q of data.qa as Data[])
    lines.push(
      pretty({
        attempt: q.attempt,
        categories: q.categories,
        frames: q.frames,
        path: `motion/qa/${run.runId}/${q.attempt}/report.json`,
      }),
    );
  lines.push(
    "",
    "## Performance",
    pretty(run.metrics),
    "",
    "## Trace",
    pretty(data.trace),
    "",
    "Artistic quality: NOT_TESTED. Missing values: NOT_AVAILABLE. SVG/binary/personal paths are omitted; large values may be truncated.",
  );
  const report = lines.join("\n");
  return report.length > 200000
    ? report.slice(0, 199940) + "\n\n[TRUNCATED: REPORT_SIZE_LIMIT]"
    : report;
}
const pretty = (v: unknown) => JSON.stringify(v ?? "NOT_AVAILABLE");
export async function debugBundle(root: string, id: string) {
  const data = await inspectorRun(root, id, true),
    zip = new JSZip();
  zip.file("report.md", debugReport(data));
  for (const [name, value] of Object.entries({
    run: data.run,
    intent: data.understanding,
    operations: (data.stateChanges as Data[]).map((h) => h.operations),
    "qa-report": data.qa,
    "state-diff": data.stateChanges,
    trace: data.trace,
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      inspectorVersion: "1.0.0",
    },
  }))
    zip.file(`${name}.json`, JSON.stringify(value, null, 2));
  let total = 0;
  const omittedFrames: string[] = [];
  for (const q of data.qa as { attempt: string; frames: string[] }[])
    for (const frame of q.frames) {
      const file = within(root, `motion/qa/${id}/${q.attempt}/${frame}`);
      await noSymlinkPath(root, file);
      const size = (await stat(file)).size;
      if (size > 8 * 1024 * 1024 || total + size > 25 * 1024 * 1024) {
        omittedFrames.push(`${q.attempt}/${frame}`);
        continue;
      }
      total += size;
      zip.file(`frames/${q.attempt}/${frame}`, await readFile(file));
    }
  zip.file(
    "bundle-limits.json",
    JSON.stringify(
      { frameBytes: total, omittedFrames, jsonProjectionLimitBytes: 2097152 },
      null,
      2,
    ),
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
