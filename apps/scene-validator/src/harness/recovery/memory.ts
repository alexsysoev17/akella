import path from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { atomicJson, noSymlinkPath, safeDirectory } from "../../files.js";
export const recoverySemanticsVersion = "motion-recovery/3";
// Executable procedures are reviewed TypeScript, never text loaded from memory.
export const recoveryRecipes = Object.freeze([
    { id: "deterministic-global-retiming/1", regression: "signed-time: dependency-aware preflight revalidation", status: "VERIFIED" as const },
    { id: "canonical-reference-rebind/1", regression: "recovery-runtime: stale reference repair", status: "VERIFIED" as const },
    { id: "dependent-tail-extension/1", regression: "native-motion-tools: ten-turn persistent lifecycle", status: "VERIFIED" as const },
    { id: "deterministic-timing-cycle-resolution/1", regression: "temporal-editing: timing cycle recovery", status: "VERIFIED" as const },
]);
const entry = z.object({ version: z.string().min(1).max(100), signature: z.string().regex(/^[a-f0-9]{64}$/), procedure: z.string().max(100), operationType: z.string().max(100).default("preflight"), preconditions: z.array(z.string().max(200)).max(8).default([]), capabilities: z.array(z.string().max(100)).max(12).default([]), validation: z.enum(["PASSED", "FAILED"]).default("FAILED"), motionSchemaVersion: z.literal("1.0.0").default("1.0.0"), status: z.enum(["SUGGESTED", "TESTED", "VERIFIED", "DEPRECATED"]), successes: z.number().int().nonnegative(), failures: z.number().int().nonnegative(), regression: z.string().nullable(), updatedAt: z.string() }).strict();
export async function recoveryMemory(root: string) {
    const file = path.join(root, "motion/harness/recovery/memory.json");
    try {
        await noSymlinkPath(root, file);
        return z.array(entry).max(200).parse(JSON.parse(await readFile(file, "utf8"))).map(row => row.version === recoverySemanticsVersion ? row : { ...row, status: "DEPRECATED" as const });
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT")
            return [];
        throw e;
    }
}
export async function rememberRecovery(root: string, signature: string, procedure: string, committed: boolean) {
    const recipe = recoveryRecipes.find(r => r.id === procedure);
    const all = await recoveryMemory(root), old = all.find(e => e.signature === signature && e.procedure === procedure);
    const row = entry.parse({ version: recoverySemanticsVersion, signature, procedure, operationType: "preflight", preconditions: procedure === "canonical-reference-rebind/1" ? ["original ID absent", "unique original-name binding", "current state authoritative"] : ["original intent admitted", "current state authoritative"], capabilities: ["findObject", "inspectAnimations", "typed Motion Tools", "scope admission", "native QA", "revision-checked commit"], validation: committed ? "PASSED" : "FAILED", motionSchemaVersion: "1.0.0", status: recipe && committed ? "VERIFIED" : committed ? "TESTED" : "SUGGESTED", successes: (old?.successes ?? 0) + (committed ? 1 : 0), failures: (old?.failures ?? 0) + (committed ? 0 : 1), regression: recipe?.regression ?? null, updatedAt: new Date().toISOString() });
    await safeDirectory(root, "motion/harness/recovery");
    await atomicJson(path.join(root, "motion/harness/recovery/memory.json"), [row, ...all.filter(e => !(e.signature === signature && e.procedure === procedure))].slice(0, 200));
}
