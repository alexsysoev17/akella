import { hostname } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  stat,
  readdir,
  readFile,
  realpath,
  rename,
  writeFile,
  rm,
  mkdir,
  open,
} from "node:fs/promises";
import path from "node:path";
import type { FileDigest } from "./types.js";
export function relativePath(value: unknown, label = "path"): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes(":") ||
    value.startsWith("/") ||
    value.split("/").some((p) => p === ".." || p === "." || !p)
  )
    throw new Error(`${label} must be a safe relative path: ${String(value)}`);
  return value;
}
export function within(root: string, relative: string): string {
  relativePath(relative);
  const target = path.resolve(root, relative);
  if (!target.startsWith(path.resolve(root) + path.sep))
    throw new Error("Path escapes root");
  return target;
}
export async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
export async function noSymlinkPath(
  root: string,
  target: string,
): Promise<void> {
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel))
    throw new Error("Path outside project");
  let cursor = root;
  for (const part of ["", ...rel.split(path.sep).filter(Boolean)]) {
    cursor = part ? path.join(cursor, part) : cursor;
    if ((await lstat(cursor)).isSymbolicLink())
      throw new Error(`Symlinks are not allowed: ${cursor}`);
  }
  const actual = await realpath(target);
  if (
    actual !== (await realpath(root)) &&
    !actual.startsWith((await realpath(root)) + path.sep)
  )
    throw new Error("Path resolves outside root");
}
const hashCache = new Map<string, { stamp: string; sha256: string }>();
export const inventoryMetrics = { bytesHashed: 0, cacheHits: 0 };
export function resetInventoryMetrics() {
  inventoryMetrics.bytesHashed = 0;
  inventoryMetrics.cacheHits = 0;
}
export async function inventory(
  root: string,
  options: { reuseHashes?: boolean } = {},
): Promise<FileDigest[]> {
  const result: FileDigest[] = [];
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Symlinks are not supported: ${file}`);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const stampOf = (v: Awaited<ReturnType<typeof lstat>>) =>
          [v.dev, v.ino, v.size, v.mtimeMs, v.ctimeMs, v.mode].join(":");
        const before = await lstat(file);
        if (!before.isFile() || before.isSymbolicLink())
          throw new Error("Source entry changed during inventory");
        const stamp = stampOf(before),
          cached = options.reuseHashes ? hashCache.get(file) : undefined;
        let sha256: string;
        if (cached?.stamp === stamp) {
          sha256 = cached.sha256;
          inventoryMetrics.cacheHits++;
        } else {
          const handle = await open(file, "r");
          try {
            const hash = createHash("sha256");
            for await (const chunk of handle.createReadStream({
              autoClose: false,
            })) {
              hash.update(chunk);
              inventoryMetrics.bytesHashed += chunk.length;
            }
            sha256 = hash.digest("hex");
          } finally {
            await handle.close();
          }
        }
        if (stampOf(await lstat(file)) !== stamp)
          throw new Error("Source changed during inventory; retry");
        if (options.reuseHashes) {
          if (hashCache.size >= 2048)
            hashCache.delete(hashCache.keys().next().value!);
          hashCache.set(file, { stamp, sha256 });
        }
        result.push({
          path: path.relative(root, file).split(path.sep).join("/"),
          size: before.size,
          sha256,
        });
      } else throw new Error(`Unsupported filesystem entry: ${file}`);
    }
  }
  await noSymlinkPath(root, root);
  await visit(root);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
export const fingerprint = (files: FileDigest[]): string =>
  createHash("sha256").update(JSON.stringify(files)).digest("hex");
export async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read valid JSON ${file}: ${String(error)}`);
  }
}
export async function atomicJson(
  file: string,
  value: unknown,
  options: { durable?: boolean } = {},
): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx");
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
    if (options.durable) await handle.sync();
    await handle.close();
    await rename(temp, file);
    // Rename is the commit point. Sync the containing directory for durable publication.
    if (options.durable) {
      const directory = await open(path.dirname(file), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await handle.close().catch(() => {});
    await rm(temp, { force: true });
  }
}
type LockOwner = {
  token: string;
  pid: number;
  host: string;
  createdAt: string;
};
async function lockOwner(lock: string): Promise<LockOwner | null> {
  try {
    const value = JSON.parse(
      await readFile(path.join(lock, "owner.json"), "utf8"),
    );
    return typeof value.token === "string" &&
      /^[a-f0-9-]{36}$/.test(value.token) &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.host === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}
export async function lockProject(root: string, options: {neverExpireLiveOwner?:boolean} = {}): Promise<() => Promise<void>> {
  const lock = path.join(root, ".project-lock");
  const owner: LockOwner = {
    token: randomUUID(),
    pid: process.pid,
    host: hostname(),
    createdAt: new Date().toISOString(),
  };
  const prepared = path.join(root, `.project-lock-prepared-${owner.token}`);
  await mkdir(prepared);
  try {
    await writeFile(path.join(prepared, "owner.json"), JSON.stringify(owner), {
      flag: "wx",
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await exists(lock)) {
        await noSymlinkPath(root, lock);
        const old = await lockOwner(lock);
        const isSameHost = Boolean(
          old &&
            (old.host === owner.host ||
              old.host.split(".")[0] === owner.host.split(".")[0] ||
              old.host === "localhost" ||
              owner.host === "localhost"),
        );
        let dead = false;
        if (old) {
          try {
            process.kill(old.pid, 0);
          } catch (error) {
            dead = (error as NodeJS.ErrnoException).code === "ESRCH";
          }
        }
        const statAgeMs = await stat(lock)
          .then((s) => Date.now() - s.mtimeMs)
          .catch(() => 0);
        const lockAgeMs = old?.createdAt
          ? Date.now() - new Date(old.createdAt).getTime()
          : statAgeMs;
        const canReclaim =
          dead || (!options.neverExpireLiveOwner && (
          (isSameHost && lockAgeMs > 60000) ||
          (!old && statAgeMs > 30000) ||
          lockAgeMs > 300000));
        if (!canReclaim) {
          if (!old || !isSameHost)
            throw new Error(
              "Project is busy; PROJECT_LOCK_OWNER_UNKNOWN: legacy or foreign lock requires inspection",
            );
          throw new Error("PROJECT_BUSY: owner process is still running");
        }
        // A retained nonempty tombstone makes a second stale reclaimer's rename fail
        // instead of moving a newly acquired lock. Never age-expire a live owner.
        try {
          await rename(
            lock,
            path.join(
              root,
              `.project-lock-recovered-${old?.token ?? randomUUID()}`,
            ),
          );
        } catch (error) {
          if (
            ["ENOENT", "EEXIST", "ENOTEMPTY"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            )
          )
            continue;
          throw error;
        }
      }
      try {
        await rename(prepared, lock);
      } catch (error) {
        if (
          ["EEXIST", "ENOTEMPTY"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          continue;
        throw error;
      }
      return async () => {
        if ((await lockOwner(lock))?.token !== owner.token)
          throw new Error("PROJECT_LOCK_OWNERSHIP_CHANGED");
        await rm(lock, { recursive: true });
      };
    }
    throw new Error("PROJECT_BUSY: concurrent acquisition or recovery");
  } finally {
    await rm(prepared, { recursive: true, force: true });
  }
}
export function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
export function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

export async function safeDirectory(
  root: string,
  relative: string,
): Promise<string> {
  relativePath(relative);
  let cursor = root;
  for (const part of relative.split("/")) {
    cursor = path.join(cursor, part);
    if (await exists(cursor)) {
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink() || !entry.isDirectory())
        throw new Error(`Unsafe output directory: ${cursor}`);
    } else await mkdir(cursor);
  }
  return cursor;
}
