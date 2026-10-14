/** Recover only whitespace formatting differences, never paraphrases or token changes. */
export function locateSource(
  request: string,
  quote: string,
  occurrence?: number,
) {
  function occurrences(haystack: string, needle: string) {
    const offsets: number[] = [];
    let at = haystack.indexOf(needle);
    while (at >= 0) {
      offsets.push(at);
      at = haystack.indexOf(needle, at + 1);
    }
    return offsets;
  }
  let starts = occurrences(request, quote);
  if (starts.length) {
    if (occurrence === undefined && starts.length !== 1)
      throw new Error("AMBIGUOUS_SOURCE_CLAUSE_SPAN");
    const start = starts[occurrence ?? 0];
    if (start === undefined) throw new Error("SOURCE_OCCURRENCE_NOT_FOUND");
    return { text: quote, start, end: start + quote.length, correction: null };
  }
  const indices: { start: number; end: number }[] = [],
    normalized: string[] = [];
  for (let i = 0; i < request.length; ) {
    const start = i;
    if (/\s/u.test(request[i])) {
      while (i < request.length && /\s/u.test(request[i])) i++;
      normalized.push(" ");
      indices.push({ start, end: i });
    } else {
      normalized.push(request[i++]);
      indices.push({ start, end: i });
    }
  }
  const compactQuote = quote.replace(/\s+/gu, " ").trim();
  if (!compactQuote) throw new Error("EMPTY_SOURCE_CLAUSE");
  starts = occurrences(normalized.join(""), compactQuote);
  if (!starts.length) throw new Error("SOURCE_CLAUSE_NOT_VERBATIM");
  if (occurrence === undefined && starts.length !== 1)
    throw new Error("AMBIGUOUS_SOURCE_CLAUSE_SPAN");
  const index = starts[occurrence ?? 0];
  if (index === undefined) throw new Error("SOURCE_OCCURRENCE_NOT_FOUND");
  const start = indices[index].start,
    end = indices[index + compactQuote.length - 1].end;
  return {
    text: request.slice(start, end),
    start,
    end,
    correction: "WHITESPACE_ONLY",
  };
}
