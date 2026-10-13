/** Redact credentials from persisted diagnostics, never from the actual model message. */
export function redactSecrets(text: string) {
  return text
    .replace(
      /\b(?:sk-[a-zA-Z0-9_-]{12,}|sk-ant-[a-zA-Z0-9_-]{10,})\b/g,
      "[REDACTED_KEY]",
    )
    .replace(/(Bearer\s+)[a-zA-Z0-9._-]{12,}/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|authorization|access[_-]?token)\s*[=:]\s*["']?)[^\s"',}]{8,}/gi,
      "$1[REDACTED]",
    );
}
export function redact<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map(redact) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /^(api[_-]?key|authorization|access[_-]?token|secret)$/i.test(k)
          ? "[REDACTED]"
          : redact(v),
      ]),
    ) as T;
  return value;
}
