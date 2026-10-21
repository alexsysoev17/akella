import type { IntentPlan } from "../../motion/intent/schema.js";
import { objectMentioned } from "../../motion/object-aliases.js";
import { recoveryFailure } from "./failure.js";
import type { RecoveryReport } from "./runtime.js";

/** Recovery entry for semantic-repair failures. It cannot emit Motion Tools
 * against an unvalidated intent, expand scope, or spend another provider call. */
export function recoverSemanticRepair(plan: IntentPlan, request: string, failure: unknown,
  revision: string, validate: (candidate: IntentPlan) => IntentPlan) {
  const report: RecoveryReport = { version: "project-recovery/1", status: "Recovering Project",
    originalFailure: recoveryFailure(failure, "semantic-repair", revision), attempts: [],
    procedure: "inherited-clause-provenance/1", codeRepairProposed: false,
    metrics: { llmCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0 } };
  try {
    const candidate = structuredClone(plan);
    const repairs = recoverSemanticProvenance(candidate, request);
    report.attempts.push({ attempt: 1, failure: report.originalFailure, action: "reconstructProvenance", tools: repairs, outcome: "PENDING" });
    if (!repairs.length) throw failure;
    const validated = validate(candidate);
    report.attempts[0].outcome = "VALIDATED";
    report.status = "Candidate Recovered";
    return { plan: validated, report };
  } catch (error) {
    report.status = "Failed Safely";
    report.terminalFailure = recoveryFailure(error, "semantic-repair", revision);
    if (report.attempts[0]) report.attempts[0].outcome = "REJECTED";
    const terminal = new Error(String(error), { cause: error });
    Object.assign(terminal, { recoveryReport: report });
    throw terminal;
  }
}

/** A provenance repair, not semantic inference: an explicit inheritance edge
 * already describes the action. Never create effects, targets or dependencies. */
export function recoverSemanticProvenance(plan: IntentPlan, request: string) {
  const repaired: { requirementId: string; sourceClauseId: string; sourceText: string }[] = [];
  const clauses = new Map(plan.sourceClauses?.map(c => [c.clauseId, c]));
  for (const r of plan.requirements) {
    if (r.unresolvedReason || !r.target.sourceNodeId || !r.target.name || !r.inheritFromRequirementId) continue;
    const parent = plan.requirements.find(p => p.requirementId === r.inheritFromRequirementId);
    const clause = parent?.sourceClauseId ? clauses.get(parent.sourceClauseId) : undefined;
    if (!parent || parent.sceneId !== r.sceneId || !clause || request.slice(clause.start, clause.end) !== clause.text ||
      !objectMentioned(r.target.name, clause.text) || !parent.techniques.length ||
      !parent.techniques.every(t => r.techniques.includes(t))) continue;
    const rows = plan.coverage.filter(row => row.sourceText === clause.text);
    if (rows.length !== 1 || rows[0].classification !== "executable" || !rows[0].requirementIds.includes(parent.requirementId)) continue;
    if (!rows[0].requirementIds.includes(r.requirementId)) {
      rows[0].requirementIds.push(r.requirementId);
      repaired.push({ requirementId: r.requirementId, sourceClauseId: clause.clauseId, sourceText: clause.text });
    }
  }
  return repaired;
}
