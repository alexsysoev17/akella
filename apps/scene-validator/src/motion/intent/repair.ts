import { z } from "zod";
import {
  intentPlanSchema,
  intentRequirementSchema,
  type IntentPlan,
} from "./schema.js";
export const targetedRepairSchema = z
  .object({
    requirements: z.array(intentRequirementSchema).max(30),
    coverageRows: intentPlanSchema.shape.coverage,
  })
  .strict();
export function mergeTargetedRepair(
  plan: IntentPlan,
  patch: z.infer<typeof targetedRepairSchema>,
  issues: { sourceText: string; requirementIds: string[] }[],
): IntentPlan {
  const ids = new Set(issues.flatMap((i) => i.requirementIds)),
    texts = new Set(issues.map((i) => i.sourceText.trim()));
  const replacements = new Map(
    patch.requirements.map((r) => [r.requirementId, r]),
  );
  if (replacements.size !== patch.requirements.length)
    throw new Error("DUPLICATE_REPAIR_REQUIREMENT");
  for (const r of patch.requirements) {
    if (
      !ids.has(r.requirementId) &&
      plan.requirements.some((p) => p.requirementId === r.requirementId)
    )
      throw new Error("REPAIR_SCOPE_VIOLATION");
    if (
      ![...texts].some(
        (t) => r.sourceText.includes(t) || t.includes(r.sourceText.trim()),
      )
    )
      throw new Error("REPAIR_SOURCE_SCOPE_VIOLATION");
  }
  for (const id of ids)
    if (!replacements.has(id)) throw new Error("REPAIR_DROPPED_REQUIREMENT");
  for (const row of patch.coverageRows)
    if (![...texts].some((t) => row.sourceText.trim() === t))
      throw new Error("REPAIR_COVERAGE_SCOPE_VIOLATION");
  return intentPlanSchema.parse({
    ...plan,
    requirements: [
      ...plan.requirements.map((r) => replacements.get(r.requirementId) ?? r),
      ...patch.requirements.filter(
        (r) =>
          !plan.requirements.some((p) => p.requirementId === r.requirementId),
      ),
    ],
    coverage: [
      ...plan.coverage.filter((row) => !texts.has(row.sourceText.trim())),
      ...patch.coverageRows,
    ],
  });
}
