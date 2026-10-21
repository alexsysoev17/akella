import { z } from "zod";
import { locateSource } from "./provenance.js";
import { objectMentioned } from "../object-aliases.js";
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
  issues: { sourceText: string; requirementIds: string[]; sourceClauseId?: string; expected?: unknown }[],
  request?: string,
): IntentPlan {
  // Spans come from the original request, never from model-authored offsets.
  const canonical = (text: string, clauseId?: string) => {
    const clause = clauseId ? plan.sourceClauses?.find(c => c.clauseId === clauseId) : undefined;
    if (clauseId && !clause) throw new Error("REPAIR_UNKNOWN_SOURCE_CLAUSE");
    if (!request) return { key: (clause?.text ?? text).replace(/\s+/gu, " ").trim(), text: clause?.text ?? text, clauseId: clause?.clauseId };
    if (clause && request.slice(clause.start, clause.end) !== clause.text) throw new Error("INVALID_SOURCE_CLAUSE_SPAN");
    // An authoritative clause ID disambiguates repeated identical quotes.
    // Whitespace differences are allowed; token changes never are.
    const compact = (value: string) => value.replace(/\s+/gu, " ").trim();
    const span = clause && compact(text) === compact(clause.text)
      ? { start: clause.start, end: clause.end, text: clause.text }
      : locateSource(request, text.trim());
    if (clause && (span.start !== clause.start || span.end !== clause.end)) throw new Error("REPAIR_SOURCE_SCOPE_VIOLATION");
    const known = clause ?? plan.sourceClauses?.find(c => c.start === span.start && c.end === span.end);
    return { key: `${span.start}:${span.end}`, text: span.text, clauseId: known?.clauseId };
  };
  const ids = new Set(issues.flatMap(i => i.requirementIds));
  const affected = new Map(issues.map(i => { const c = canonical(i.sourceText, i.sourceClauseId); return [c.key, c]; }));
  const replacements = new Map(
    patch.requirements.map((r) => [r.requirementId, r]),
  );
  if (replacements.size !== patch.requirements.length)
    throw new Error("DUPLICATE_REPAIR_REQUIREMENT");
  const requirements = patch.requirements.map(r => structuredClone(r));
  for (const r of requirements) {
    if (
      !ids.has(r.requirementId) &&
      plan.requirements.some((p) => p.requirementId === r.requirementId)
    )
      throw new Error("REPAIR_SCOPE_VIOLATION");
    const source = canonical(r.sourceText, r.sourceClauseId);
    if (!affected.has(source.key))
      throw new Error("REPAIR_SOURCE_SCOPE_VIOLATION");
    r.sourceText = affected.get(source.key)!.text;
    if (source.clauseId) r.sourceClauseId = source.clauseId;
    if (!plan.requirements.some(p => p.requirementId === r.requirementId)) {
      const target = `${r.sceneId}/${r.target.sourceNodeId}`;
      const issue = issues.find(i => canonical(i.sourceText, i.sourceClauseId).key === source.key &&
        (i.expected as { target?: string } | undefined)?.target === target);
      if (!r.target.name || !objectMentioned(r.target.name, source.text) ||
        (!issue && issues.some(i => canonical(i.sourceText, i.sourceClauseId).key === source.key && (i.expected as { target?: string } | undefined)?.target)))
        throw new Error("REPAIR_TARGET_SCOPE_VIOLATION");
    }
  }
  const replacementsById = new Map(requirements.map(r => [r.requirementId, r]));
  const canonicalRow = (row: IntentPlan["coverage"][number], original = false) => {
    const knownIds = new Set(row.requirementIds.map(id =>
      (!original ? replacementsById.get(id) : undefined)?.sourceClauseId ??
      plan.requirements.find(r => r.requirementId === id)?.sourceClauseId));
    const candidates = plan.sourceClauses?.filter(c => knownIds.has(c.clauseId) &&
      c.text.replace(/\s+/gu, " ").trim() === row.sourceText.replace(/\s+/gu, " ").trim()) ?? [];
    return canonical(row.sourceText, candidates.length === 1 ? candidates[0].clauseId : undefined);
  };
  const rows = new Map<string, IntentPlan["coverage"][number]>();
  for (const row of patch.coverageRows) {
    let source: ReturnType<typeof canonical>;
    try { source = canonicalRow(row); }
    catch {
      // A row with no unique authoritative span cannot authorize anything.
      // Requirements were validated separately above; retain the original rows.
      continue;
    }
    // An extra mapping cannot authorize writes to another clause. Keep its
    // authoritative original row; admit only the independently valid correction.
    if (!affected.has(source.key)) continue;
    if (row.requirementIds.some(id => {
      const replacement = replacementsById.get(id);
      if (replacement && canonical(replacement.sourceText, replacement.sourceClauseId).key === source.key) return false;
      return !plan.coverage.some(old => canonicalRow(old, true).key === source.key && old.requirementIds.includes(id));
    }))
      throw new Error("REPAIR_COVERAGE_TARGET_SCOPE_VIOLATION");
    const previous = rows.get(source.key);
    rows.set(source.key, { ...row, sourceText: affected.get(source.key)!.text,
      requirementIds: [...new Set([...(previous?.requirementIds ?? []), ...row.requirementIds])] });
  }
  const coverage = plan.coverage.map(row => {
    const key = canonicalRow(row, true).key;
    const replacement = rows.get(key);
    if (!replacement) return row;
    rows.delete(key);
    return { ...replacement, requirementIds: [...new Set([...row.requirementIds, ...replacement.requirementIds])] };
  });
  return intentPlanSchema.parse({
    ...plan,
    requirements: [
      ...plan.requirements.map((r) => replacementsById.get(r.requirementId) ?? r),
      ...requirements.filter(
        (r) =>
          !plan.requirements.some((p) => p.requirementId === r.requirementId),
      ),
    ],
    coverage: [...coverage, ...rows.values()],
  });
}
