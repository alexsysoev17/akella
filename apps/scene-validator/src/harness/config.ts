import { recoveryPolicySchema } from "./recovery/config.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { noSymlinkPath } from "../files.js";
import path from "node:path";
export const harnessConfigSchema = z
  .object({
    recovery: recoveryPolicySchema.default(recoveryPolicySchema.parse({})),
    modelProfiles: z
      .array(
        z
          .object({
            provider: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
            model: z.string().max(200),
            contextWindowTokens: z.number().int().positive(),
            maxOutputTokens: z.number().int().positive(),
            transportOverheadTokens: z.number().int().min(0),
            reasoningReserveTokens:z.number().int().min(0).optional(),
            source:z.string().max(300).optional(),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    maxLLMCalls: z.number().int().min(1).max(10).default(3),
    maxRepairAttempts: z.number().int().min(0).max(2).default(2),
    // Memory/transport ceiling only. Model token admission is a separate gate.
    maxContextBytes: z.number().int().min(4000).max(4000000).default(2000000),
    maxOutputTokens: z.number().int().min(100).max(100000).default(16000),
    maxRenderedQAFrames: z.number().int().min(5).max(500).default(300),
    maxDurationMs: z.number().int().min(1000).max(900000).default(240000),
    semanticPlanningTimeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(300000)
      .default(180000),
    repairBudgetMs: z.number().int().min(1000).max(300000).default(60000),
    minimumRetryBudgetMs: z.number().int().min(1).max(180000).default(15000),
    executionReserveMs: z.number().int().min(0).max(60000).default(10000),
    directTimeoutRetries: z.number().int().min(0).max(2).default(1),
    directContinuationBudgetMs: z.number().int().min(1000).max(600000).default(180000),
    providerTimeoutMs: z.number().int().min(1000).max(300000).default(180000),
    maxEstimatedCost: z.number().positive().nullable().default(null),
    privacy: z.enum(["full", "metadata", "off"]).default("full"),
    historyMaxRuns: z.number().int().min(2).max(1000).default(200),
    historyMaxAgeDays: z.number().int().min(1).max(3650).default(90),
    historyMaxBytes: z
      .number()
      .int()
      .min(1048576)
      .max(1073741824)
      .default(104857600),
    qaCacheEntries: z.number().int().min(0).max(200).default(30),
    extraGuidance: z.array(z.string().max(1000)).max(10).default([]),
    retrievalBoosts: z.array(z.string().max(100)).max(10).default([]),
  })
  .strict();
export type HarnessConfig = z.infer<typeof harnessConfigSchema>;
export async function harnessConfig(
  root: string,
  override?: Partial<HarnessConfig>,
) {
  let raw: unknown = {};
  const file = path.join(root, "motion/harness/config.json");
  try {
    await noSymlinkPath(root, file);
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return harnessConfigSchema.parse({
    ...harnessConfigSchema.parse(raw),
    ...override,
  });
}
