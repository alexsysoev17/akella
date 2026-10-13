/** Reference matching is a lookup layer; canonical logical IDs remain exact-name hashes. */
export const normalizeObjectName = (name: string) =>
  name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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
const ordinals: Record<string, string> = {
  перв: "1",
  втор: "2",
  трет: "3",
  треть: "3",
  четверт: "4",
  пят: "5",
  шест: "6",
  седьм: "7",
  восьм: "8",
  девят: "9",
  десят: "10",
  одиннадцат: "11",
  двенадцат: "12",
  тринадцат: "13",
  четырнадцат: "14",
  пятнадцат: "15",
  шестнадцат: "16",
  семнадцат: "17",
  восемнадцат: "18",
  девятнадцат: "19",
  двадцат: "20",
};
// Conservative productive inflections, not phonetic/fuzzy matching or a full Russian lemmatizer.
function stem(word: string) {
  if (!/^[а-я]+$/.test(word)) return word;
  const ending = word.match(
    /(?:иями|ями|ами|ого|его|ому|ему|ыми|ими|ая|яя|ую|юю|ое|ее|ые|ие|ый|ий|ой|ою|ей|ью|ам|ям|ах|ях|ов|ев|ом|ем|ым|им|а|я|у|ю|е|ы|и|ь)$/,
  )?.[0];
  const root = ending ? word.slice(0, -ending.length) : word;
  return root.length >= 3 ? root : word;
}
function tokens(text: string) {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({
    word: normalizeObjectName(m[0]),
    start: m.index!,
    end: m.index! + m[0].length,
  }));
}
function signature(words: string[]) {
  const parts = words.map((w) => ordinals[stem(w)] ?? stem(w));
  // Ordinal word order may change; the numbered identity must never change.
  return JSON.stringify({
    words: parts.filter((w) => !/^\d+$/.test(w)),
    numbers: parts.filter((w) => /^\d+$/.test(w)),
  });
}
export function objectAliases(name: string): string[] {
  const n = normalizeObjectName(name),
    key = signature(tokens(n).map((t) => t.word));
  return (
    groups.find((g) =>
      g.some((a) => signature(tokens(a).map((t) => t.word)) === key),
    ) ?? [n]
  );
}
export function objectNameMatch(
  canonical: string,
  reference: string,
): "exact" | "normalized" | "alias" | "morphological" | null {
  if (canonical === reference) return "exact";
  if (normalizeObjectName(canonical) === normalizeObjectName(reference))
    return "normalized";
  const words = tokens(reference).map((t) => t.word);
  // Leading grammatical prepositions are not object identity.
  while (["у", "для", "на", "к", "о", "об"].includes(words[0])) words.shift();
  const key = signature(words);
  for (const alias of objectAliases(canonical))
    if (signature(tokens(alias).map((t) => t.word)) === key)
      return normalizeObjectName(alias) === normalizeObjectName(reference)
        ? "alias"
        : "morphological";
  return null;
}
export const equivalentObjectName = (a: string, b: string) =>
  objectNameMatch(a, b) !== null;
export function objectMentionRanges(
  name: string,
  text: string,
): { start: number; end: number }[] {
  // Bare canvas/frame numbers inside a longer reference are not object mentions.
  if (
    /^\d+$/.test(normalizeObjectName(name)) &&
    normalizeObjectName(text) !== normalizeObjectName(name)
  )
    return [];
  const words = tokens(text),
    found: { start: number; end: number }[] = [];
  for (const alias of objectAliases(name)) {
    const size = tokens(alias).length;
    if (!size) continue;
    for (let i = 0; i + size <= words.length; i++) {
      const slice = words.slice(i, i + size);
      if (objectNameMatch(alias, text.slice(slice[0].start, slice.at(-1)!.end)))
        found.push({ start: slice[0].start, end: slice.at(-1)!.end });
    }
  }
  return [
    ...new Map(found.map((r) => [r.start + ":" + r.end, r])).values(),
  ].sort((a, b) => a.start - b.start || b.end - a.end);
}
export const objectMentioned = (name: string, text: string) =>
  objectMentionRanges(name, text).length > 0;
