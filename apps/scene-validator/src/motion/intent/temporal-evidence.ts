/** Conservative coverage evidence, not a second language planner. Word order alone
 * never authorizes an inter-object edge. Offsets use the original request. */
export interface TemporalEvidence {
 sourceSpan:{start:number;end:number;text:string};
 sourceRequirementId:string|null;targetRequirementId:string;
 relation:'afterEnd'|'afterStart'|'absolute'|'delay'|'proceduralAfterMotion';
 evidence:string;classification:'explicit'|'implicit';
}
export function temporalCues(text:string){
 const pattern=/(?:в\s+момент\s+)?(?:как|когда)\s*(?:он[аои]?\s*)?(?:законч|заканч|конча)[а-я]*|после\s+(?:заверш|оконч|перв|начала|старта)[а-я]*|(?:а\s+)?(?:потом|затем)|сразу\s+(?:вслед|после)/giu;
 return [...text.matchAll(pattern)].map(m=>{
  const before=text.slice(0,m.index),after=text.slice(m.index!+m[0].length).trimStart();
  const descriptiveDecay=/^(?:затуха|ослабева|успокаива)/iu.test(after)&&/(?:колеб|инерци|покач)/iu.test(before);
  const ownMovementTail=/^(?:движения|перемещения|анимации|перехода|остановки)\s*(?:(?:у\s+(?:него|неё|них)|он[аои]?|они)\s+)?(?:затуха|колеб|инерци|покач|появля|начина)/iu.test(after)&&/(?:колеб|инерци|покач)/iu.test(after);
  const relation=descriptiveDecay||ownMovementTail?'proceduralAfterMotion' as const:/после\s+(?:начала|старта)/iu.test(m[0])?'afterStart' as const:'afterEnd' as const;
  return {start:m.index!,end:m.index!+m[0].length,text:m[0],relation};
 });
}
export const hasActionSequence=(text:string)=>temporalCues(text).some(c=>c.relation==='afterEnd');
