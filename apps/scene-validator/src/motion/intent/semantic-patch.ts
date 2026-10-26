import type { IntentPlan } from './schema.js';
import type { CoverageReport } from './coverage.js';

/** Repair evidence comes from a fresh coverage report over the authoritative request.
 * This is deliberately narrower than general temporal interpretation. */
export function patchSequentialDependencies(plan: IntentPlan, request: string, report: CoverageReport) {
 const patches: {requirementId:string;sourceText:string;before:unknown;after:unknown}[]=[];
 for(const issue of report.issues){
  if(issue.code!=='MISSING_SEQUENTIAL_DEPENDENCY'||issue.requirementIds.length!==1)continue;
  const expected=issue.expected as {relation?:string;anchorRequirementId?:string;align?:string}|undefined;
  if(expected?.relation!=='afterRequirement'||expected.align!=='start'||!expected.anchorRequirementId)continue;
  const clause=report.clauses.filter(c=>c.sourceText===issue.sourceText&&request.slice(c.start,c.end).trim()===c.sourceText.trim());
  if(clause.length!==1)continue;
  const child=plan.requirements.find(r=>r.requirementId===issue.requirementIds[0]);
  const anchor=plan.requirements.find(r=>r.requirementId===expected.anchorRequirementId);
  if(!child||!anchor||child===anchor||child.unresolvedReason||anchor.unresolvedReason)continue;
  // The one absolute first action and one relative second action in the SAME
  // clause make the expected edge unambiguous; a generic 'then' elsewhere does not.
  const members=plan.requirements.filter(r=>clause[0].requirementIds.includes(r.requirementId));
  if(members.length!==2||!members.includes(child)||!members.includes(anchor)||anchor.timing.startSeconds===null)continue;
  if(!issue.sourceText.includes(child.sourceText.trim())||!issue.sourceText.includes(anchor.sourceText.trim()))continue;
  if(child.sourceClauseId||anchor.sourceClauseId){
   const spans=[child,anchor].map(r=>plan.sourceClauses?.find(c=>c.clauseId===r.sourceClauseId));
   if(spans.some(c=>!c||request.slice(c.start,c.end)!==c.text||c.start<clause[0].start||c.end>clause[0].end))continue;
  }
  if(child.sceneId!==anchor.sceneId||!child.target.sourceNodeId||child.target.sourceNodeId!==anchor.target.sourceNodeId)continue;
  if(child.timing.startSeconds!==null||child.timing.reference||child.timing.delaySeconds<0||(child.timing.offsetFrames??0)<0)continue;
  if([...child.constraints,...anchor.constraints].some(c=>/врем|кадр|секунд|длитель|одновременно|после|до начала|time|frame|second|duration|same time/iu.test(c))||/одновременно|вместе|не\s+после|не\s+потом|до\s+оконч|simultaneous|together|before/iu.test(issue.sourceText))continue;
  if(!/(?:а\s+)?потом|затем|после\s+(?:заверш|оконч)|когда.*законч/iu.test(issue.sourceText))continue;
  if(child.timing.anchorRequirementId&&child.timing.anchorRequirementId!==anchor.requirementId)continue;
  if(!['sceneStart','afterRequirement'].includes(child.timing.relation))continue;
  if([child,anchor].some(r=>r.parameters.durationSeconds!==null&&r.parameters.durationSeconds<=0))continue;
  const before=structuredClone(child.timing),after={...before,relation:'afterRequirement' as const,anchorRequirementId:anchor.requirementId,align:'start' as const};
  // Check the entire proposed dependency graph, not just this pair.
  const seen=new Set<string>(),visiting=new Set<string>();
  const visit=(id:string):boolean=>{if(visiting.has(id))return false;if(seen.has(id))return true;const r=plan.requirements.find(x=>x.requirementId===id);if(!r)return false;visiting.add(id);const next=r===child?after.anchorRequirementId:r.timing.anchorRequirementId;if(next&&!visit(next))return false;visiting.delete(id);seen.add(id);return true;};
  if(!plan.requirements.every(r=>visit(r.requirementId)))continue;
  if(JSON.stringify(before)===JSON.stringify(after))continue;
  child.timing=after;patches.push({requirementId:child.requirementId,sourceText:issue.sourceText,before,after});
 }
 return patches;
}
