import type { Json } from "../types/scene";
// Figma mixed is a symbol: preserve it explicitly instead of silently dropping it.
export function toJson(value: unknown): Json {
  if (typeof value === "symbol") return { mixed: true };
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite JSON number");
    return value;
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined && typeof v !== "function") out[k] = toJson(v);
    }
    return out;
  }
  throw new Error(`Unsupported JSON value: ${typeof value}`);
}
export const serialize = (value: unknown): string =>
  JSON.stringify(toJson(value), null, 2);
export function safeId(id: string): string {
  return Array.from(id)
    .map((c) =>
      /[a-zA-Z0-9-]/.test(c) ? c : `_${c.charCodeAt(0).toString(16)}_`,
    )
    .join("");
}
