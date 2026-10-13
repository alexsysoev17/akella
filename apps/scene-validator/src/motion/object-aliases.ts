/** Retrieval aliases never alter exact-name logical identity. No fuzzy/substring binding. */
export const normalizeObjectName = (name: string) =>
  name.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const groups = [
  [
    "qr",
    "qr code",
    "qr-code",
    "qrcode",
    "qr код",
    "qr-код",
    "куар",
    "куар код",
    "куар-код",
  ],
  ["logo", "лого", "логотип"],
];
export function objectAliases(name: string): string[] {
  const normalized = normalizeObjectName(name);
  return groups.find((g) => g.includes(normalized)) ?? [normalized];
}
export const equivalentObjectName = (a: string, b: string) =>
  objectAliases(a).includes(normalizeObjectName(b));
export function objectMentioned(name: string, text: string): boolean {
  const normalized = normalizeObjectName(text);
  return objectAliases(name).some((alias) => {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,
      "u",
    ).test(normalized);
  });
}
export function objectMentionRanges(
  name: string,
  text: string,
): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
  for (const alias of objectAliases(name)) {
    const escaped = alias
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/ /g, "\\s+");
    for (const m of text.matchAll(
      new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "giu"),
    ))
      found.push({ start: m.index!, end: m.index! + m[0].length });
  }
  return found.sort((a, b) => a.start - b.start);
}
