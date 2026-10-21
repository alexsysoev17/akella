import test from "node:test";
import assert from "node:assert/strict";
import fixture from "./fixtures/semantic-coverage-ribbons.json" with { type: "json" };
import { normalizeSemanticGraph } from "../src/motion/intent/graph.js";
import { mergeTargetedRepair } from "../src/motion/intent/repair.js";
import { recoverSemanticProvenance, recoverSemanticRepair } from "../src/harness/recovery/semantic.js";
import { locateSource } from "../src/motion/intent/provenance.js";

const draft = () => {
  const plan = normalizeSemanticGraph(fixture.graph, { sceneIndex: [0,1,2,3].map(i => ({ sceneId: `s${i}`, index: i })) }, fixture.prompt);
  // The production planner resolves canonical IDs before recovery.
  plan.requirements.forEach(r => { if (r.target.name) r.target.sourceNodeId = `fixture-${r.target.name}`; });
  return plan;
};
test("saved Russian prompt: recovery reconnects existing inherited Trim Paths without creating another animation", () => {
  const p = draft(), before = structuredClone(p.requirements);
  const events = recoverSemanticProvenance(p, fixture.prompt);
  assert.equal(events.length, 1);
  assert.equal(events[0].sourceClauseId, "c_ribbons");
  assert.deepEqual(p.requirements, before);
  const ribbons = p.requirements.filter(r => r.target.name?.startsWith("лента"));
  assert.equal(ribbons.length, 2);
  assert.equal(ribbons[1].timing.anchorRequirementId, ribbons[0].requirementId);
  assert.ok(p.coverage.find(c => c.sourceText === ribbons[0].sourceText)!.requirementIds.includes(ribbons[1].requirementId));
  assert.equal(recoverSemanticProvenance(p, fixture.prompt).length, 0, "idempotent; no repeated recovery");
});
test("targeted patch admits an explicitly named missing ribbon, canonicalizes whitespace and isolates unrelated rows", () => {
  const p = draft(), first = p.requirements.find(r => r.target.name === "лента 1")!;
  const missing = structuredClone(p.requirements.find(r => r.target.name === "лента 2")!);
  missing.requirementId = "added-ribbon";
  missing.sourceClauseId = first.sourceClauseId;
  missing.sourceText = first.sourceText.replace(/ /g, "\u00a0");
  const unaffected = structuredClone(p);
  // This test exercises a genuinely missing action, unlike the historical
  // run whose inherited action already existed.
  p.requirements = p.requirements.filter(r => r.target.name !== "лента 2");
  p.coverage = p.coverage.filter(c => c.sourceText !== unaffected.requirements.find(r => r.target.name === "лента 2")!.sourceText);
  const issues = [{ sourceClauseId: first.sourceClauseId, sourceText: first.sourceText, requirementIds: [], expected: { target: `${missing.sceneId}/${missing.target.sourceNodeId}` } }];
  const merged = mergeTargetedRepair(p, { requirements: [missing], coverageRows: [
    { sourceText: missing.sourceText, requirementIds: [missing.requirementId], classification: "executable", explanation: "missing target" },
    { ...unaffected.coverage.at(-1)!, requirementIds: [missing.requirementId] },
  ] }, issues, fixture.prompt);
  assert.equal(merged.requirements.at(-1)!.sourceText, first.sourceText);
  assert.deepEqual(merged.requirements.slice(0, -1), p.requirements);
  assert.deepEqual(merged.coverage.filter(c => c.sourceText !== first.sourceText), p.coverage.filter(c => c.sourceText !== first.sourceText));
  assert.ok(merged.coverage.find(c => c.sourceText === first.sourceText)!.requirementIds.includes(first.requirementId));
  const foreign = structuredClone(missing);
  foreign.target.name = "unrelated object";
  assert.throws(() => mergeTargetedRepair(p, { requirements: [foreign], coverageRows: [] }, issues, fixture.prompt), /TARGET_SCOPE/);
  assert.throws(() => mergeTargetedRepair(p, { requirements: [p.requirements[0]], coverageRows: [] }, issues, fixture.prompt), /REPAIR_SCOPE/);
});
test("source span ambiguity is rejected; canonical IDs never authorize different source text", () => {
  const p = draft(), r = p.requirements.find(r => r.target.name === "лента 1")!;
  const issue = { sourceClauseId: r.sourceClauseId, sourceText: r.sourceText, requirementIds: [r.requirementId] };
  assert.throws(() => mergeTargetedRepair(p, { requirements: [{ ...r, sourceText: p.requirements[0].sourceText }], coverageRows: [] }, [issue], fixture.prompt), /SOURCE_SCOPE/);
  assert.throws(() => locateSource("repeat repeat", "repeat"), /AMBIGUOUS/);
  const repeatedRequest = fixture.prompt + " " + r.sourceText;
  const repaired = mergeTargetedRepair(p, { requirements: [r], coverageRows: [p.coverage.find(row => row.requirementIds.includes(r.requirementId))!] }, [issue], repeatedRequest);
  assert.deepEqual(repaired.requirements, p.requirements, "authoritative clause ID disambiguates repeated quotes");
});
test("semantic repair failure enters bounded Recovery Runtime and cannot bypass complete validation", () => {
  const p = draft(), before = structuredClone(p);
  let validations = 0;
  const recovered = recoverSemanticRepair(p, fixture.prompt, new Error("REPAIR_COVERAGE_SCOPE_VIOLATION"), "initial", candidate => {
    validations++;
    assert.equal(candidate.coverage.find(c => c.sourceText === candidate.requirements.find(r => r.target.name === "лента 1")!.sourceText)!.requirementIds.length, 2);
    return candidate;
  });
  assert.equal(validations, 1);
  assert.equal(recovered.report.originalFailure.stage, "semantic-repair");
  assert.equal(recovered.report.metrics?.llmCalls, 0);
  assert.equal(recovered.report.status, "Candidate Recovered");
  assert.deepEqual(p, before, "authoritative input unchanged");
  assert.throws(() => recoverSemanticRepair(p, fixture.prompt, new Error("REPAIR_COVERAGE_SCOPE_VIOLATION"), "initial", () => { throw new Error("MISSING_EXPLICIT_TECHNIQUE"); }), /MISSING_EXPLICIT_TECHNIQUE/);
});
