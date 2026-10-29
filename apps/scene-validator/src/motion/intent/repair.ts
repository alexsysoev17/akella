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
  const canonical = (text: string, clauseId?: string, contained = false) => {
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
    if (clause && (contained ? span.start < clause.start || span.end > clause.end : span.start !== clause.start || span.end !== clause.end)) throw new Error("REPAIR_SOURCE_SCOPE_VIOLATION");
    const known = clause ?? plan.sourceClauses?.find(c => c.start === span.start && c.end === span.end);
    return { key: `${span.start}:${span.end}`, text: span.text, clauseId: known?.clauseId };
  };
  const ids = new Set(issues.flatMap(i => i.requirementIds));
  const affected = new Map(issues.map(i => { const c = canonical(i.sourceText, i.sourceClauseId, true); return [c.key, c]; }));
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
    const original=plan.requirements.find(p=>p.requirementId===r.requirementId);
    // An authorized requirement may quote its containing paragraph while the
    // validator identifies a smaller evidence span. Timing edits retain that
    // authoritative provenance verbatim; they do not rewrite the paragraph.
    const retainedProvenance=!affected.has(source.key)&&original&&ids.has(r.requirementId)&&r.sourceText===original.sourceText&&r.sourceClauseId===original.sourceClauseId&&request&&issues.filter(i=>i.requirementIds.includes(r.requirementId)).some(i=>{
      const issueSpan=locateSource(request,i.sourceText.trim());
      const originalClause=original.sourceClauseId?plan.sourceClauses?.find(c=>c.clauseId===original.sourceClauseId):undefined;
      const originalSpan=originalClause??locateSource(request,original.sourceText.trim());
      return issueSpan.start>=originalSpan.start&&issueSpan.end<=originalSpan.end;
    });
    if (!affected.has(source.key)&&!retainedProvenance)
      throw new Error("REPAIR_SOURCE_SCOPE_VIOLATION");
    r.sourceText = retainedProvenance?original!.sourceText:affected.get(source.key)!.text;
    if (source.clauseId) r.sourceClauseId = source.clauseId;
    if (!plan.requirements.some(p => p.requirementId === r.requirementId)) {
      const target = `${r.sceneId}/${r.target.sourceNodeId}`;
      const issue = issues.find(i => canonical(i.sourceText, i.sourceClauseId, true).key === source.key &&
        (i.expected as { target?: string } | undefined)?.target === target);
      if (!r.target.name || !objectMentioned(r.target.name, source.text) ||
        (!issue && issues.some(i => canonical(i.sourceText, i.sourceClauseId, true).key === source.key && (i.expected as { target?: string } | undefined)?.target)))
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
      return !plan.coverage.some(old => {try{return canonicalRow(old, true).key === source.key && old.requirementIds.includes(id);}catch{return false;}});
    }))
      throw new Error("REPAIR_COVERAGE_TARGET_SCOPE_VIOLATION");
    const previous = rows.get(source.key);
    rows.set(source.key, { ...row, sourceText: affected.get(source.key)!.text,
      requirementIds: [...new Set([...(previous?.requirementIds ?? []), ...row.requirementIds])] });
  }
  const coverage = plan.coverage.map(row => {
    let key:string;
    try{key=canonicalRow(row,true).key;}catch{return row;} // Repeated untouched context rows do not authorize writes and need no guessed occurrence.
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

// Field deltas avoid re-emitting every null/default field of large valid requirements.
const editableFields=['techniques','target','sceneId','timing','parameters','inheritFromRequirementId','inheritanceExplanation','kind','unresolvedReason','sourceText','sourceClauseId'] as const;
const changeOptions=editableFields.map(field=>z.object({field:z.literal(field),value:intentRequirementSchema.shape[field]}).strict());
export const compactRepairSchema=z.object({
 updates:z.array(z.object({requirementId:z.string(),changes:z.array(z.union(changeOptions as unknown as [typeof changeOptions[number],...typeof changeOptions[number][]])).min(1).max(12)}).strict()).max(30),
 addedRequirements:z.array(intentRequirementSchema).max(12),coverageRows:z.array(intentPlanSchema.shape.coverage.element).max(200),
}).strict();
export interface RepairScopeDiagnostics {
 allowedRequirementIds:string[];
 sourceSpans:{requirementIds:string[];sourceClauseId?:string;start?:number;end?:number;sourceText:string}[];
 proposedUpdates:unknown[];acceptedRequirementIds:string[];
 rejected:{requirementId?:string;fields:string[];code:string;changes:unknown}[];
 rejectedRequirementIds:string[];
}
export function mergeCompactRepair(plan:IntentPlan,input:unknown,issues:Parameters<typeof mergeTargetedRepair>[2],request:string){
 const patch=compactRepairSchema.parse({addedRequirements:[],coverageRows:[],...input as object}),seen=new Set<string>();
 const duplicateIds=new Set(patch.updates.filter((u,i,all)=>all.findIndex(a=>a.requirementId===u.requirementId)!==i).map(u=>u.requirementId));
 const allowed=new Set(issues.flatMap(i=>i.requirementIds));
 const diagnostics:RepairScopeDiagnostics={allowedRequirementIds:[...allowed],sourceSpans:issues.map(i=>{let span;try{span=locateSource(request,i.sourceText.trim());}catch{}return {requirementIds:i.requirementIds,sourceClauseId:i.sourceClauseId,start:span?.start,end:span?.end,sourceText:i.sourceText};}),proposedUpdates:patch.updates,acceptedRequirementIds:[],rejected:[],rejectedRequirementIds:[]};
 const requirements:IntentPlan['requirements']=[];
 const reject=(id:string|undefined,fields:string[],changes:unknown,error:unknown)=>{diagnostics.rejected.push({requirementId:id,fields,changes,code:String(error).replace(/^Error: /,'')});if(id)diagnostics.rejectedRequirementIds.push(id);};
 for(const update of patch.updates){try{
  if(duplicateIds.has(update.requirementId)||seen.has(update.requirementId))throw Error('DUPLICATE_REPAIR_REQUIREMENT');seen.add(update.requirementId);
  const original=plan.requirements.find(r=>r.requirementId===update.requirementId);if(!original)throw Error('REPAIR_UNKNOWN_REQUIREMENT');
  if(!allowed.has(update.requirementId))throw Error('REPAIR_SCOPE_VIOLATION');
  if(issues.length&&issues.every(i=>(i as {code?:string}).code==='MISSING_SEQUENTIAL_DEPENDENCY')&&update.changes.some(c=>c.field!=='timing'))throw Error('REPAIR_FIELD_SCOPE_VIOLATION');
  const result=structuredClone(original),fields=new Set<string>();
  for(const change of update.changes){if(fields.has(change.field))throw Error('DUPLICATE_REPAIR_FIELD');fields.add(change.field);Object.assign(result,{[change.field]:change.field==='parameters'&&change.value&&typeof change.value==='object'?{...result.parameters,...Object.fromEntries(Object.entries(change.value).filter(([,v])=>v!==null&&v!==undefined))}:change.value});}
  const parsed=intentRequirementSchema.parse(result);
  mergeTargetedRepair(plan,{requirements:[parsed],coverageRows:[]},issues,request);
  requirements.push(parsed);diagnostics.acceptedRequirementIds.push(parsed.requirementId);
 }catch(error){reject(update.requirementId,update.changes.map(c=>c.field),update.changes,error);}}
 for(const added of patch.addedRequirements){try{mergeTargetedRepair(plan,{requirements:[added],coverageRows:[]},issues,request);requirements.push(added);diagnostics.acceptedRequirementIds.push(added.requirementId);}catch(error){reject(added.requirementId,['addedRequirement'],added,error);}}
 const rows:IntentPlan['coverage']=[];
 for(const row of patch.coverageRows){try{mergeTargetedRepair(plan,{requirements,coverageRows:[row]},issues,request);rows.push(row);}catch(error){reject(undefined,['coverageRow'],row,error);}}
 if(diagnostics.rejected.length&&!requirements.length&&!rows.length)throw Object.assign(Error(diagnostics.rejected[0].code),{repairScopeDiagnostics:diagnostics});
 const merged=mergeTargetedRepair(plan,{requirements,coverageRows:rows},issues,request);
 Object.defineProperty(merged,'repairScopeDiagnostics',{value:diagnostics,enumerable:false});
 return merged;
}

/** Timing-only defects do not need the complete effect/parameter schema on the wire. */
export function semanticRepairSchema(issues: {code?:string}[]): z.ZodType {
 if(issues.length && issues.every(i=>i.code==='MISSING_SEQUENTIAL_DEPENDENCY'))return z.object({updates:z.array(z.object({requirementId:z.string(),changes:z.array(z.object({field:z.literal('timing'),value:intentRequirementSchema.shape.timing}).strict()).length(1)}).strict()).max(30)}).strict();
 return compactRepairSchema;
}
