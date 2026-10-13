import { readdir, stat, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { noSymlinkPath } from "../files.js";
/** Only Harness run records. Source, undo history and user assets are never touched. */
export async function retainRuns(
  root: string,
  policy: { maxRuns: number; maxAgeDays: number; maxBytes: number },
  keepId: string,
) {
  const dir = path.join(root, "motion/harness/runs");
  await noSymlinkPath(root, dir);
  const entries = [];
  for (const id of (await readdir(dir)).filter(
    (id) => z.uuid().safeParse(id).success,
  )) {
    const base = path.join(dir, id);
    await noSymlinkPath(root, base);
    const file = path.join(base, "run.json");
    await noSymlinkPath(root, file);
    const info = await stat(file);
    if (info.size > 8 * 1024 * 1024) continue;
    const run = JSON.parse(await readFile(file, "utf8")) as {
      status: string;
      createdAt: string;
    };
    if (run.status === "RUNNING" || id === keepId) continue;
    const trace = path.join(base, "trace.json");
    let size = info.size;
    try {
      await noSymlinkPath(root, trace);
      size += (await stat(trace)).size;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    entries.push({
      id,
      base,
      size,
      time: Date.parse(run.createdAt) || info.mtimeMs,
    });
  }
  entries.sort((a, b) => b.time - a.time);
  let bytes = 0;
  for (const [i, e] of entries.entries()) {
    bytes += e.size;
    if (
      i >= policy.maxRuns - 1 ||
      Date.now() - e.time > policy.maxAgeDays * 86400000 ||
      bytes > policy.maxBytes
    )
      await rm(e.base, { recursive: true, force: true });
  }
}
