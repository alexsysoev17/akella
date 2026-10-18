import { z } from "zod";
import { providerIds, createProvider } from "../harness/providers/index.js";
import { redactSecrets } from "../harness/security.js";
import {
  DEFAULT_PROVIDER_ID,
  MANUAL_PROVIDER_ID,
  PROVIDER_ID_PATTERN,
  PROVIDER_SETTINGS_MESSAGE,
  LEGACY_PROVIDER_ALIASES,
} from "../provider-contract.js";
import { readOptional } from "../management.js";
import { atomicJson, safeDirectory } from "../files.js";
import type { LoadedProject } from "../types.js";
import path from "node:path";
export const providerSettingsSchema = z
  .object({
    provider: z
      .string()
      .regex(PROVIDER_ID_PATTERN)
      .default(DEFAULT_PROVIDER_ID)
      .refine(
        (id) => id === MANUAL_PROVIDER_ID || providerIds().includes(id),
        "Provider ID is not registered",
      ),
    model: z
      .string()
      .max(200)
      .regex(/^(?:[a-zA-Z0-9][a-zA-Z0-9._:/+-]*)?$/)
      .refine(
        (value) => !value.includes("://"),
        "Model IDs are not endpoint URLs",
      )
      .refine(
        (value) => redactSecrets(value) === value,
        "Credentials are not model IDs",
      )
      .default(""),
  })
  .strict();
export type ProviderSettings = z.infer<typeof providerSettingsSchema>;
function safeValue(value: unknown) {
  if (typeof value !== "string")
    return value === undefined ? "MISSING" : "NON_STRING";
  return value.length <= 100 && !/^[A-Za-z0-9_-]{24,}$/.test(value)
    ? redactSecrets(value)
    : "[REDACTED_OPAQUE_VALUE]";
}
export class ProviderSettingsError extends Error {
  readonly code = "PROVIDER_SETTINGS_INVALID";
  constructor(
    public diagnostic: {
      errorCode: string;
      validationPath: (string | number)[];
      actualValue: unknown;
      expectedFormat: string;
      source: string;
      providerInitializationStatus: string;
    },
  ) {
    super(PROVIDER_SETTINGS_MESSAGE);
  }
}
export function parseProviderSettings(
  value: unknown,
  source: string,
): ProviderSettings {
  const parsed = providerSettingsSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0],
    raw =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
  const key = issue.path[0] === undefined ? null : String(issue.path[0]);
  throw new ProviderSettingsError({
    errorCode:
      issue.code === "custom" &&
      key === "provider" &&
      typeof raw.provider === "string" &&
      PROVIDER_ID_PATTERN.test(raw.provider)
        ? "PROVIDER_NOT_REGISTERED"
        : "PROVIDER_SETTINGS_FORMAT",
    validationPath: [
      "settings",
      ...issue.path.map((p) => (typeof p === "symbol" ? String(p) : p)),
    ],
    actualValue: key ? safeValue(raw[key]) : "INVALID_SETTINGS_OBJECT",
    expectedFormat:
      key === null
        ? "strict object: provider/model"
        : key === "provider"
          ? `${PROVIDER_ID_PATTERN}; registered: ${providerIds().join(", ")}; ${MANUAL_PROVIDER_ID} is manual compatibility`
          : "model: identifier (namespace/tag supported); no URLs/credentials/whitespace; max200",
    source,
    providerInitializationStatus: "NOT_INITIALIZED",
  });
}
export async function saveProviderSettings(
  project: LoadedProject,
  value: unknown,
  source = "api",
) {
  const settings = parseProviderSettings(value, source);
  const persistent =
    settings.provider === MANUAL_PROVIDER_ID ||
    createProvider(settings.provider, project.root).mode === "live";
  if (persistent) {
    const dir = await safeDirectory(project.root, "motion/ai");
    await atomicJson(path.join(dir, "provider.json"), settings);
  }
  return { settings, persisted: persistent };
}
export async function loadProviderSettings(project: LoadedProject) {
  const text = await readOptional(project.root, "motion/ai/provider.json");
  if (text === undefined)
    return {
      settings: parseProviderSettings({}, "default"),
      source: "default",
    };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProviderSettingsError({
      errorCode: "PROVIDER_SETTINGS_JSON",
      validationPath: ["settings"],
      actualValue: "INVALID_JSON",
      expectedFormat: "JSON object with provider/model",
      source: "persisted",
      providerInitializationStatus: "NOT_INITIALIZED",
    });
  }
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : undefined;
  const alias =
    raw && typeof raw.provider === "string"
      ? LEGACY_PROVIDER_ALIASES[raw.provider]
      : undefined;
  if (alias) {
    const result = await saveProviderSettings(
      project,
      { ...raw, provider: alias },
      "known-legacy-alias",
    );
    return {
      settings: result.settings,
      source: "known-legacy-alias",
      migratedFrom: safeValue(raw!.provider),
    };
  }
  return {
    settings: parseProviderSettings(value, "persisted"),
    source: "persisted",
  };
}
