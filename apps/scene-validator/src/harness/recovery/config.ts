import { z } from "zod";
export const recoveryPolicySchema = z.object({
    enabled: z.boolean().default(true),
    model: z.string().min(1).max(200).default("gpt-6-sol"),
    effort: z.enum(["low", "medium", "high"]).default("low"),
    maxAttempts: z.number().int().min(0).max(3).default(3),
    maxContextBytes: z.number().int().min(2000).max(60000).default(20000),
    maxOutputTokens: z.number().int().min(100).max(16000).default(4000),
    maxTokens: z.number().int().min(1000).max(100000).default(24000),
    maxDurationMs: z.number().int().min(1000).max(180000).default(60000),
    maxEstimatedCost: z.number().positive().nullable().default(null),
    codeRepair: z.object({ enabled: z.boolean().default(true), model: z.string().min(1).max(200).default("gpt-6-sol"), effort: z.enum(["low", "medium", "high"]).default("medium"), maxDurationMs: z.number().int().min(1000).max(300000).default(120000), maxContextBytes: z.number().int().min(4000).max(200000).default(140000), maxOutputTokens: z.number().int().min(100).max(20000).default(12000), maxTokens: z.number().int().min(1000).max(200000).default(60000), maxEstimatedCost: z.number().positive().nullable().default(null) }).strict().default({ enabled: true, model: "gpt-6-sol", effort: "medium", maxDurationMs: 120000, maxContextBytes: 140000, maxOutputTokens: 12000, maxTokens: 60000, maxEstimatedCost: null }),
}).strict();
export type RecoveryPolicy = z.infer<typeof recoveryPolicySchema>;
