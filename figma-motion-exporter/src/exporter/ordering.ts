import type { FrameSummary } from "../types/scene";
export function orderFrames<T extends FrameSummary>(frames: readonly T[]): T[] {
  const prefix = (name: string) => /^(\d+)(?:[\s_.-]|$)/.exec(name);
  const numeric = frames.every((f) => prefix(f.name));
  return [...frames].sort((a, b) =>
    numeric
      ? Number(prefix(a.name)![1]) - Number(prefix(b.name)![1]) ||
        a.x - b.x ||
        a.y - b.y ||
        a.id.localeCompare(b.id)
      : a.x - b.x || a.y - b.y || a.id.localeCompare(b.id),
  );
}
