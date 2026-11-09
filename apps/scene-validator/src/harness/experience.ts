import { redact } from "./security.js";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { atomicJson, noSymlinkPath, safeDirectory } from "../files.js";
export interface Experience {
  runId: string;
  createdAt: string;
  status: string;
  request?: string;
  techniques: string[];
  failures: string[];
  repairs: number;
  objectiveQA: string;
  artisticQuality: "NOT_TESTED";
  versions: unknown;
  recoveryLesson?: {procedure:string;failureCode:string;verifiedCommit:boolean};
}
export async function saveExperience(root: string, value: Experience) {
  const dir = await safeDirectory(root, "motion/harness/experience");
  await atomicJson(path.join(dir, value.runId + ".json"), redact(value));
}
export async function experiences(root: string): Promise<Experience[]> {
  const dir = path.join(root, "motion/harness/experience");
  try {
    await noSymlinkPath(root, dir);
    const files = (await readdir(dir))
      .filter((f) => /^[a-f0-9-]{36}\.json$/.test(f))
      .slice(-1000);
    const result: Experience[] = [];
    for (const f of files) {
      await noSymlinkPath(root, path.join(dir, f));
      result.push(JSON.parse(await readFile(path.join(dir, f), "utf8")));
    }
    return result;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
export async function experienceSearch(
  root: string,
  request: string,
  techniques: string[],
  limit = 3,
) {
  const words = new Set(
    request.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [],
  );
  return (await experiences(root))
    .map((e) => ({
      e,
      score:
        e.techniques.filter((t) => techniques.includes(t)).length * 3 +
        (e.request?.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(
          (w) => words.has(w),
        ).length,
    }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ e }) => ({
      runId: e.runId,
      status: e.status,
      techniques: e.techniques,
      failures: e.failures,
      objectiveQA: e.objectiveQA,
      artisticQuality: e.artisticQuality,
      recoveryLesson:e.recoveryLesson,
    }));
}
