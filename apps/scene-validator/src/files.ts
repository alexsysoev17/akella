import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  readdir,
  readFile,
  realpath,
  rename,
  writeFile,
  rm,
  mkdir,
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
export async function inventory(root: string): Promise<FileDigest[]> {
  const result: FileDigest[] = [];
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Symlinks are not supported: ${file}`);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const bytes = await readFile(file);
        result.push({
          path: path.relative(root, file).split(path.sep).join("/"),
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
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
export async function atomicJson(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  try {
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}
export async function lockProject(root: string): Promise<() => Promise<void>> {
  const { rm } = await import("node:fs/promises");
  const lock = path.join(root, ".project-lock");
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        `Project is busy, or a previous process stopped unexpectedly. Lock: ${lock}`,
      );
    throw error;
  }
  return () => rm(lock, { recursive: true, force: true });
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
