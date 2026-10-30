import { z } from 'zod';
import type { LoadedProject } from '../types.js';
import type { MotionDocument } from './store.js';
import { ruleObjects } from './rules.js';
import { objectMentionRanges } from './object-aliases.js';
import { semanticEditSchema, type SemanticEdit } from './rule-contract.js';
import { normalizeSemanticGraph } from './intent/graph.js';
import {recentSuccessfulActions} from './contextual-resolution.js';
import {relativeIntensityFactors} from '../motion-library/expressions/registry.js';
import { ruleSkills } from '../motion-library/skills/rule-skills.js';

// Context routing only; unfamiliar language remains the existing provider's responsibility.
export const localModifierPolicy = { ...relativeIntensityFactors, slower:.8, faster:1.25 } as const;
/** Parameter-local relative edits. A qualitative effect preamble supplies strength,
 * not another multiplication; unqualified frequency reduction keeps the established ×.5 policy. */
function compoundParameterFactors(text:string): {amplitudeFactor?:number;frequencyFactor?:number}|null {
  const verbs='сделай|уменьши|увеличь|измени';
  const clauses=text.split(new RegExp(`\\s+(?:и\\s+)?(?=(?:${verbs})\\s)`,'u'));
  let inherited:number|undefined;
  const result:{amplitudeFactor?:number;frequencyFactor?:number}={};
  const factor=(clause:string):number|undefined=>{
    const weak=/слабее|послабее|уменьши/u.test(clause),strong=/сильнее|посильнее|увеличь/u.test(clause);
    if(weak===strong)return undefined;
    const percent=[...clause.matchAll(/на (\d+(?:\.\d+)?)%/gu)],times=[...clause.matchAll(/в (два|\d+(?:\.\d+)?) раза/gu)];
    if(percent.length+times.length>1)return undefined;
    let n:number;
    if(percent.length)n=1+(strong?1:-1)*Number(percent[0][1])/100;
    else if(times.length||/вдвое/u.test(clause)){const x=times.length?(times[0][1]==='два'?2:Number(times[0][1])):2;n=weak?1/x:x;}
    else n=weak?(/гораздо|значительно|намного/u.test(clause)?localModifierPolicy.muchWeaker:/чуть|немного/u.test(clause)?localModifierPolicy.slightlyWeaker:localModifierPolicy.weaker):(/гораздо|значительно|намного/u.test(clause)?localModifierPolicy.muchStronger:/чуть|немного/u.test(clause)?localModifierPolicy.slightlyStronger:localModifierPolicy.stronger);
    return Number.isFinite(n)&&n>0&&n<=10?n:undefined;
  };
  for(const clause of clauses){
    if(!/амплитуд|частот/u.test(clause)){
      if(inherited!==undefined||Object.keys(result).length)return null;
      inherited=factor(clause);if(inherited===undefined)return null;continue;
    }
    const prefix=clause.slice(0,clause.search(/амплитуд|частот/u));
    const parts=[...clause.matchAll(/(амплитуд[уы]|частот[уы])([^]*?)(?=амплитуд[уы]|частот[уы]|$)/gu)];
    // «Уменьши амплитуду и частоту на20%» shares one modifier;
    // «амплитуду вдвое и частоту на20%» has two separate modifiers.
    const shared=parts.length>1&&parts.slice(0,-1).every(p=>p[2].trim().split(/\s+/u).every(w=>!w||['и','колебаний'].includes(w)))?parts.at(-1)![2]:'';
    for(const part of parts){
      const key=part[1].startsWith('амплитуд')?'amplitudeFactor':'frequencyFactor';
      if(result[key]!==undefined)return null;
      const tail=part[2]+(part!==parts.at(-1)?shared:''),local=prefix+part[1]+tail,ownModifier=/\d|вдвое|слабее|послабее|сильнее|посильнее|чуть|немного|гораздо|значительно|намного/u.test(tail);
      let value=factor(local);
      if(key==='amplitudeFactor'&&inherited!==undefined&&!ownModifier){
        if(value===undefined||(value<1)!==(inherited<1))return null;
        value=inherited;
      }
      if(value===undefined)return null;result[key]=value;
    }
  }
  return Object.keys(result).length?result:null;
}
export function incrementalEditProfile(project: LoadedProject, request: string, doc?:MotionDocument) {
  if (request.length > 1600 || /сцен|scene|появ|уход|перемест|trim|фейд|fade|после|затем|кадр|frame/iu.test(request)) return null;
  if (/wiggle|покач/iu.test(request) && /инерц|колеб/iu.test(request)) return null;
  let effect:SemanticEdit['effect']|null = /wiggle|покач/iu.test(request) ? 'wiggle' : /инерц|колеб/iu.test(request) ? 'inertialOvershoot' : /движени|длитель|easing|изинг/iu.test(request)?'motion':null;
  if (!/добав|убер|удал|измени|сделай|уменьш|увелич|слаб|силь|амплитуд|частот|включ|отключ|верни|быстр|медлен|add|remove|update/iu.test(request)) return null;
  const registry=ruleObjects(project);
  const referencedRule=doc?.state.motionRules?.find(r=>request.includes(r.ruleId));
  effect??=referencedRule?.effect??null;
  let objects = registry.filter(o => objectMentionRanges(o.name, request).length);
  if(!objects.length&&referencedRule) objects=registry.filter(o=>!referencedRule.scope.logicalObjectIds.length||referencedRule.scope.logicalObjectIds.includes(o.logicalObjectId));
  if(!objects.length&&/всех\s+объект|в\s+проекте/iu.test(request))return null;
  if (!objects.length && doc && /ещ[её]|слаб|силь|верни|быстр|медлен/iu.test(request)) {
    const recent=recentSuccessfulActions(doc).find(a=>(!effect||a.effect===effect)&&['wiggle','inertialOvershoot'].includes(a.effect));
    if(recent) {
      const current=(doc.state.expressions??[]).filter(e=>recent.expressionIds.includes(e.expressionId));
      objects=registry.filter(o=>current.some(e=>e.ownership?.logicalObjectId===o.logicalObjectId||o.sourceInstances.some(i=>i.sceneId===e.sceneId&&i.sourceNodeId===e.targetId)));
      effect??=recent.effect as 'wiggle'|'inertialOvershoot';
    }
  }
  if(!effect&&doc&&objects.length&&/амплитуд|частот/iu.test(request)){
    const types=[...new Set((doc.state.expressions??[]).filter(e=>objects.some(o=>e.ownership?.logicalObjectId===o.logicalObjectId||o.sourceInstances.some(i=>i.sceneId===e.sceneId&&i.sourceNodeId===e.targetId))).map(e=>e.type))];
    if(types.length===1&&['wiggle','inertialOvershoot'].includes(types[0]))effect=types[0] as 'wiggle'|'inertialOvershoot';
  }
  if (!effect || !objects.length || objects.some(o => o.ambiguousScenes.length)) return null;
  return { effect, objects };
}
export const incrementalEditSchema = z.object({ edits: z.array(semanticEditSchema).min(1).max(20), assumptions: z.array(z.string()).max(20) }).strict();
export const incrementalEditInstructions = `Interpret this local motion-effect edit, retaining every requested modifier. Return typed semantic edits only. Use actual supplied logical object IDs, never invent identities. ADD_EFFECT adds an effect; MODIFY_EFFECT updates existing parameters; REMOVE_EFFECT removes only that effect. Rule modifications use actual supplied rule IDs. Scope must remain within admitted objects; never expand to project. Wiggle is continuous smooth seeded motion, rotation by default, amplitude 3 degrees and frequency .8 Hz unless requested otherwise. Existing parameters and base animations remain unchanged when editing. Inertia requires real base movement. Unknown identity or unsupported instructions must not be guessed. No new base animation, scene timing or geometry in this contract.`;
export function incrementalContext(project: LoadedProject, doc: MotionDocument, request: string, profile: NonNullable<ReturnType<typeof incrementalEditProfile>>) {
  const ids = new Set(profile.objects.map(o => o.logicalObjectId));
  const owns = (scene: string, target: string) => profile.objects.some(o => o.sourceInstances.some(i => i.sceneId === scene && i.sourceNodeId === target));
  return {
    incrementalEditHint: true,
    project: {projectId: project.config.projectId, fps: doc.state.settings.fps, durationFrames: doc.state.settings.durationFrames},
    projectRevision: doc.revision,
    userRequest: request,
    objectIndex: profile.objects.map(o => ({logicalObjectId:o.logicalObjectId, name:o.name, sourceInstances:o.sourceInstances})),
    // No geometry, full graph, unrelated history or implementation snippets.
    effectState: {
      expressions: (doc.state.expressions ?? []).filter(e => e.type === profile.effect && (e.ownership?.logicalObjectId ? ids.has(e.ownership.logicalObjectId) : owns(e.sceneId,e.targetId))),
      rules: (doc.state.motionRules ?? []).filter(r => r.effect === profile.effect && (!r.scope.logicalObjectIds.length || r.scope.logicalObjectIds.some(id => ids.has(id)))),
      ...(profile.effect === 'inertialOvershoot'||profile.effect==='motion' ? {
        animations: doc.state.animations.filter(a => owns(a.sceneId,a.targetId)),
        transitions: (doc.state.objectTransitions ?? []).filter(t => ids.has(t.logicalObjectId)),
      } : {}),
    },
    skill: ruleSkills.filter(s => s.id === (profile.effect === 'wiggle' ? 'motion.continuous-wiggle' : 'motion.inertia-after-movement')).map(({id,version,description,defaults,constraints}) => ({id,version,effect:profile.effect,description,defaults,constraints})),
    constraints: {allowedLogicalObjectIds:[...ids], preserveBaseAnimations:true, preserveOtherEffects:true},
  };
}
/** Closed, fully consumed grammar only. Any extra modifier/unknown target falls back to semantic interpretation. */
export function deterministicIncrementalEdit(project: LoadedProject, request: string, doc?:MotionDocument): SemanticEdit | null {
  const profile = incrementalEditProfile(project, request,doc);
  if (!profile) return null;
  const referencedRule=doc?.state.motionRules?.find(r=>request.includes(r.ruleId));
  const chars = request.split('');
  if(referencedRule){const at=request.indexOf(referencedRule.ruleId);chars.fill(' ',at,at+referencedRule.ruleId.length);}
  for (const o of profile.objects) for (const range of objectMentionRanges(o.name, request)) chars.fill(' ', range.start, range.end);
  if(/-\s*\d/u.test(request))return null;
  const rest = chars.join('').toLowerCase().replace(/(\d)[.,](?=\d)/gu,'$1§').replace(/[,.!—–-]/g,' ').replace(/§/g,'.').replace(/ё/g,'е').replace(/\s+/g,' ').trim();
  const compound=/амплитуд/u.test(rest)&&/частот/u.test(rest);
  if(!compound&&(rest.match(/(?:сделай|уменьши|увеличь|измени|добавь|добавить|убери|удали|включи|отключи)/gu)?.length??0)>1)return null;
  let operation: SemanticEdit['operation'];
  const parameters:SemanticEdit['parameters']={};
  let amplitudeFactor:number|undefined,frequencyFactor:number|undefined,durationFactor:number|undefined;
  // Every word must be consumed: unknown modifiers/negations require compact semantic interpretation.
  const known=/^(?:сделай|уменьши|увеличь|измени|добавь|добавить|убери|удали|включи|отключи|у|на|к|и|в|два|раза|раз|эффект|эффекта|колебаний|колебания|колебание|инерцию|инерции|покачивание|покачивания|постоянного|постоянное|постоянный|wiggle|амплитуду|амплитуды|частоту|частоты|движения|движений|все|только|еще|чуть|немного|значительно|гораздо|намного|слабее|послабее|сильнее|посильнее|вдвое|медленнее|быстрее|объекты|объектам|правило|правила|исключение|исключения|из|для|линейный|линейное|изинг|easing|linear|easeInOutCubic|easeInCubic|easeOutCubic|\d+(?:\.\d+)?%?)$/iu;
  if(!rest.split(' ').every(word=>known.test(word)))return null;
  if(compound){
    if(!['wiggle','inertialOvershoot'].includes(profile.effect)||/добав|убери|удали|включи|отключи|быстрее|медленнее|правил|исключени/u.test(rest))return null;
    const factors=compoundParameterFactors(rest);if(!factors)return null;
    operation='MODIFY_PARAMETER';({amplitudeFactor,frequencyFactor}=factors);
  }
  else if(referencedRule&&/исключени/u.test(rest)&&/^(?:добавь|убери|удали)/u.test(rest))operation=/^добавь/u.test(rest)?'ADD_EXCEPTION':'REMOVE_EXCEPTION';
  else if(referencedRule&&/правил/u.test(rest)&&/^(?:убери|удали)/u.test(rest))operation='REMOVE_RULE';
  else if(/^добавь/u.test(rest)&&/правило/u.test(rest))operation='ADD_RULE';
  else if (/^(?:добавь|добавить)/u.test(rest)&&profile.effect==='wiggle'&&/постоянн/u.test(rest)) operation='ADD_EFFECT';
  else if (/^(?:убери|удали)/u.test(rest)) operation='REMOVE_EFFECT';
  else if (/^включи/u.test(rest)) operation='ENABLE_EFFECT';
  else if (/^отключи/u.test(rest)) operation='DISABLE_EFFECT';
  else {
    const weaker=/слабее|уменьши/u.test(rest), stronger=/сильнее|увеличь/u.test(rest);
    if(weaker&&stronger)return null;
    const percent=rest.match(/на (\d+(?:\.\d+)?)%/u),times=rest.match(/в (два|\d+(?:\.\d+)?) раза/u);
    let factor:number|undefined;
    if(percent&&times)return null;
    if(percent)factor=weaker?1-Number(percent[1])/100:stronger?1+Number(percent[1])/100:undefined;
    else if(times||/вдвое/u.test(rest)){const n=times?(times[1]==='два'?2:Number(times[1])):2;factor=weaker?1/n:stronger?n:undefined;}
    else if(weaker||stronger){const level=/гораздо|значительно|намного/u.test(rest)?'much':/чуть|немного/u.test(rest)?'slightly':'';factor=weaker?(level==='much'?localModifierPolicy.muchWeaker:level==='slightly'?localModifierPolicy.slightlyWeaker:localModifierPolicy.weaker):(level==='much'?localModifierPolicy.muchStronger:level==='slightly'?localModifierPolicy.slightlyStronger:localModifierPolicy.stronger);}
    if(/быстрее|медленнее/u.test(rest)){const n=times?(times[1]==='два'?2:Number(times[1])):/вдвое/u.test(rest)?2:undefined;factor=n?(/быстрее/u.test(rest)?n:1/n):/быстрее/u.test(rest)?localModifierPolicy.faster:localModifierPolicy.slower;}
    if(factor!==undefined&&(!Number.isFinite(factor)||factor<=0||factor>10))return null;
    if(profile.effect==='motion') {
      if(/easing|изинг/u.test(rest)) {operation='MODIFY_EASING'; const easing=(['linear','easeInOutCubic','easeInCubic','easeOutCubic'] as const).find(name=>rest.split(' ').includes(name.toLowerCase()));if(!easing)return null;parameters.easing=easing;}
      else {if(!factor)return null;operation='MODIFY_DURATION';durationFactor=1/factor;if(durationFactor>10)return null;}
    } else {
      if(!factor||factor<=0||factor>10)return null;
      operation='MODIFY_PARAMETER';
      if(/частот|быстрее|медленнее/u.test(rest))frequencyFactor=factor;else amplitudeFactor=factor;
    }
  }
  if(operation!=='ADD_EFFECT'&&operation!=='ADD_RULE'&&doc&&profile.effect!=='motion') {
    const ids=new Set(profile.objects.map(o=>o.logicalObjectId));
    if(!(doc.state.expressions??[]).some(e=>e.type===profile.effect&&(e.ownership?.logicalObjectId?ids.has(e.ownership.logicalObjectId):profile.objects.some(o=>o.sourceInstances.some(i=>i.sceneId===e.sceneId&&i.sourceNodeId===e.targetId))))&&!(doc.state.motionRules??[]).some(r=>r.effect===profile.effect&&(!r.scope.logicalObjectIds.length||r.scope.logicalObjectIds.some(id=>ids.has(id)))))return null;
  }
  return semanticEditSchema.parse({operation,effect:profile.effect,...(referencedRule?{ruleId:referencedRule.ruleId}:{}),targets:profile.objects.map(o=>o.logicalObjectId),scope:{selector:'objects',phase:'all'},parameters,...(amplitudeFactor!==undefined?{amplitudeFactor}:{}),...(frequencyFactor!==undefined?{frequencyFactor}:{}),...(durationFactor!==undefined?{durationFactor}:{})});
}
export function incrementalGraphContext(context: unknown) {
  const c=context as ReturnType<typeof incrementalContext>;
  return {...c,objectIndex:c.objectIndex.flatMap(o=>o.sourceInstances.map(i=>({...i,name:o.name})))};
}
export function incrementalPlan(request: string, edits: SemanticEdit[], context: unknown, assumptions: string[] = []) {
  const c = context as ReturnType<typeof incrementalContext>;
  const admitted = new Set(c.objectIndex.map(o=>o.logicalObjectId));
  for (const edit of edits) {
    if (edit.scope.selector === 'project' || !edit.targets.length || [...edit.targets,...edit.excludedTargets,...edit.scope.logicalObjectIds].some(id=>!admitted.has(id))) throw Error('INCREMENTAL_SCOPE_VIOLATION');
    if (edit.effect!=='motion'&&!c.skill.some(s=>s.effect===edit.effect)) throw Error('INCREMENTAL_EFFECT_NOT_ADMITTED');
    if (edit.ruleId) {
      const rule=c.effectState.rules.find(r=>r.ruleId===edit.ruleId);
      if (!rule || (!['ADD_EXCEPTION','REMOVE_EXCEPTION'].includes(edit.operation)&&!request.includes(rule.ruleId)&&(rule.scope.selector==='project'||rule.scope.logicalObjectIds.some(id=>!admitted.has(id))))) throw Error('INCREMENTAL_RULE_NOT_ADMITTED: editing a broader rule requires explicit wider admission');
    }
  }
  return normalizeSemanticGraph({schemaVersion:'semantic-graph/1.0',clauses:[{clauseId:'edit',text:request}],actions:edits.map((edit,i)=>({actionId:'edit_'+i,clauseId:'edit',kind:'editAnimation',scene:c.objectIndex.find(o=>o.logicalObjectId===edit.targets[0])!.sourceInstances[0].sceneId,constraints:[],unresolvedReason:null,targets:[c.objectIndex.find(o=>o.logicalObjectId===edit.targets[0])!.sourceInstances[0].sourceNodeId],techniques:[edit.effect === 'motion' ? 'customCurve' : edit.effect === 'easing' ? 'customCurve' : edit.effect === 'fade' ? 'fadeIn' : edit.effect],relation:'unchanged',parameters:[],semanticEdit:edit})),assumptions},incrementalGraphContext(context),request);
}
