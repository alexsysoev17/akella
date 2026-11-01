import {parseAnchorEdit} from './anchor-language.js';
import { z } from 'zod';
import type { LoadedProject } from '../types.js';
import type { MotionDocument } from './store.js';
import { ruleObjects,compileSemanticEdit } from './rules.js';
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
export function incrementalEditProfile(project: LoadedProject, request: string, doc?:MotionDocument, editor?:{currentFrame?:number;activeSceneId?:string;selectedObjectId?:string;selectedObjectIds?:string[];selectedSceneId?:string;mentions?:{sourceNodeId:string;sceneId:string}[]}) {
  if(/(?:(?:сцена|scene)\s*\d+|\d+\s*сцена)\s+(?:начинается|начинаются|начнет|начнется|starts? at)/iu.test(request))return null;
  if(/anchor|pivot|точк[ауи] (?:вращения|масштабирования)|относительно (?:центр|верхн|нижн|лев|прав)|вокруг.*цент|из центра/iu.test(request)&&/инерц|колеб|покач|wiggle|spring|отскок|фейд|fade|прозрач|easing|изинг/iu.test(request))return null;
  const retiming=/позже|позд|раньше|медленнее|быстрее|длитель|начинается|после завершения/u.test(request);
  if (request.length > 1600 || (!retiming&&/сцен|scene|появ|уход|перемест|trim|фейд|fade|после|затем|кадр|frame/iu.test(request.replace(/после движени[йя]/giu,'')))) return null;
  if (/wiggle|покач/iu.test(request) && /инерц|колеб/iu.test(request)) return null;
  let effect:SemanticEdit['effect']|null = /anchor|pivot|точк[ауи] (?:вращения|масштабирования)|относительно (?:центр|верхн|нижн|лев|прав)|вокруг.*цент|из центра/iu.test(request)?'anchor': /wiggle|покач|постоянн.*колеб|колеб.*постоянн/iu.test(request) ? 'wiggle' : /инерц|колеб/iu.test(request) ? 'inertialOvershoot' : /движени|длитель|easing|изинг|позже|раньше|появлен|появля|начинается/iu.test(request)?'motion':null;
  // Route unfamiliar language by authoritative existing targets, not a verb whitelist.
  if(/создай|создать|новую композици|новый ролик|create (?:a |new )/iu.test(request))return null;
  const registry=ruleObjects(project);
  const referencedRule=doc?.state.motionRules?.find(r=>request.includes(r.ruleId));
  effect??=referencedRule?.effect??null;
  let objects = registry.filter(o => objectMentionRanges(o.name, request).length);
  if(!objects.length&&/всем\s+зв[её]здам/iu.test(request))objects=registry.filter(o=>/^звезда\s+\d+$/iu.test(o.name));
  if(!objects.length&&editor){const selected=[...(editor.selectedObjectIds??[]),...(editor.selectedObjectId?[editor.selectedObjectId]:[])];objects=registry.filter(o=>selected.includes(o.logicalObjectId)||o.sourceInstances.some(i=>(selected.includes(i.sourceNodeId)&&(!editor.selectedSceneId||i.sceneId===editor.selectedSceneId))||editor.mentions?.some(m=>m.sceneId===i.sceneId&&m.sourceNodeId===i.sourceNodeId)));}
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
  // Bare oscillation language is contextual, never a synonym for continuous noise.
  if(doc&&objects.length&&/колеб/iu.test(request)&&!/инерц|после.*движ|после.*заверш|затуха|постоянн|wiggle|покач/iu.test(request)){
    const owns=(scene:string,target:string)=>objects.some(o=>o.sourceInstances.some(i=>i.sceneId===scene&&i.sourceNodeId===target));
    const types=new Set((doc.state.expressions??[]).filter(e=>(e.enabled||/включи|отключи/iu.test(request))&&owns(e.sceneId,e.targetId)).map(e=>e.type).filter(t=>['wiggle','inertialOvershoot'].includes(t)));
    for(const r of doc.state.motionRules??[])if(r.enabled&&['wiggle','inertialOvershoot'].includes(r.effect)&&objects.some(o=>!r.exceptions.includes(o.logicalObjectId)&&(!r.scope.logicalObjectIds.length||r.scope.logicalObjectIds.includes(o.logicalObjectId))))types.add(r.effect as 'wiggle'|'inertialOvershoot');
    if(types.size===1)effect=[...types][0] as SemanticEdit['effect'];
    else {
      const recent=recentSuccessfulActions(doc).find(a=>['wiggle','inertialOvershoot'].includes(a.effect)&&a.expressionIds.some(id=>(doc.state.expressions??[]).some(e=>e.expressionId===id&&e.enabled&&owns(e.sceneId,e.targetId))));
      if(recent)effect=recent.effect as SemanticEdit['effect'];
      else throw Error('AMBIGUOUS_EFFECT_TYPE: specify inertia after movement or continuous wiggle');
    }
  }
  if(!effect&&doc&&objects.length&&/амплитуд|частот|слаб|силь|затух/iu.test(request)){
    const types=[...new Set((doc.state.expressions??[]).filter(e=>objects.some(o=>e.ownership?.logicalObjectId===o.logicalObjectId||o.sourceInstances.some(i=>i.sceneId===e.sceneId&&i.sourceNodeId===e.targetId))).map(e=>e.type))];
    if(types.length===1&&['wiggle','inertialOvershoot'].includes(types[0]))effect=types[0] as 'wiggle'|'inertialOvershoot';
  }
  if(!effect&&doc&&objects.some(o=>doc.state.animations.some(a=>o.sourceInstances.some(i=>i.sceneId===a.sceneId&&i.sourceNodeId===a.targetId))))effect='motion';
  if (!effect || !objects.length || objects.some(o => o.ambiguousScenes.length)) return null;
  return { effect, objects,currentFrame:editor?.currentFrame??0 };
}
/** One routing decision; unknown editing language stays compact, not full re-planning. */
export function semanticEditRoute(project:LoadedProject,request:string,doc:MotionDocument,editor?:Parameters<typeof incrementalEditProfile>[3]){
 const profile=incrementalEditProfile(project,request,doc,editor);
 let edit=profile?deterministicIncrementalEdit(project,request,doc,editor):null;
 if(edit&&profile&&['SHIFT_START','SET_START','SHIFT_END','SET_DURATION','SCALE_DURATION'].includes(edit.operation)){
  try{compileSemanticEdit(project,doc.state,edit,request);}catch(error){if(String(error).includes('AMBIGUOUS_ENTRANCE_TIMING'))edit=null;else throw error;}
 }
 return {mode:edit?'LOCAL_DETERMINISTIC_EDIT' as const:profile?'COMPACT_SEMANTIC_PATCH' as const:'FULL_SEMANTIC_PLANNING' as const,profile,edit};
}
export const incrementalQuerySchema=z.object({kind:z.enum(['inspectObject','inspectAnimations','inspectDependencies','inspectExpressions','inspectMotionRules','inspectSceneStates']),logicalObjectId:z.string().min(1)}).strict();
export const incrementalEditSchema = z.object({ edits: z.array(semanticEditSchema).max(20), assumptions: z.array(z.string()).max(20),queries:z.array(incrementalQuerySchema).max(6).optional() }).strict().refine(v=>v.edits.length>0||Boolean(v.queries?.length),'Expected edits or bounded context queries');
export const incrementalEditInstructions = `Interpret this local motion-effect edit, retaining every requested modifier. Return typed semantic edits only. Anchor uses effect=anchor, operation=SET_ANCHOR|CENTER_ANCHOR|RESET_ANCHOR|MOVE_ANCHOR|SET_SCALE_ORIGIN|SET_ROTATION_ORIGIN, anchor={action,frame,point:{units:normalized|pixels,x,y},scope:object|scene|fromFrame,preserveVisualPosition:true,space:local}. Scene context stays in edit.scope.sceneId. Never change motion tracks to simulate a pivot. Use actual supplied logical object IDs, never invent identities. ADD_EFFECT adds an effect; MODIFY_EFFECT updates existing parameters; REMOVE_EFFECT removes only that effect. Rule modifications use actual supplied rule IDs. Scope must remain within admitted objects; never expand to project. Wiggle is continuous smooth seeded motion. Plain wiggle uses effectStorage=expression with existing engine X/Y defaults; explicit pokachivanie uses persistent rule rotation, amplitude3 degrees/frequency.8Hz. Keep existing channels when editing; never substitute rotation for X/Y. Existing parameters and base animations remain unchanged when editing. Inertia requires real base movement. The admitted skill effect is authoritative: never substitute continuous wiggle for admitted inertia. Bare oscillations require current effect/rule or committed-action evidence, otherwise report ambiguity. Unknown identity or unsupported instructions must not be guessed. For existing motion use SHIFT_START with signed deltaFrames (canonical frames), SET_START/frameValue, SHIFT_END, SET_DURATION/frameValue or SCALE_DURATION/durationFactor, MODIFY_EASING/parameters.easing. phase=entrance selects only appearance, never exits. Explicit animationIds disambiguate repeated entrances. Preserve line stagger and attached expressions; dependencyPolicy=preserve-relative unless absolute dependents must stay fixed. EDIT current motion; no full-project regeneration. If evidence is missing, return edits:[] and bounded queries [{kind:inspectObject|inspectAnimations|inspectDependencies|inspectExpressions|inspectMotionRules|inspectSceneStates,logicalObjectId:actual admitted ID}]. One read-only disclosure round is available. Never fabricate an ID.`;
export function incrementalContext(project: LoadedProject, doc: MotionDocument, request: string, profile: NonNullable<ReturnType<typeof incrementalEditProfile>>) {
  const ids = new Set(profile.objects.map(o => o.logicalObjectId));
  const owns = (scene: string, target: string) => profile.objects.some(o => o.sourceInstances.some(i => i.sceneId === scene && i.sourceNodeId === target));
  return {
    incrementalEditHint: true,
    incrementalEffect:profile.effect,
    project: {projectId: project.config.projectId, fps: doc.state.settings.fps, durationFrames: doc.state.settings.durationFrames},
    projectRevision: doc.revision,
    sceneIndex:project.inspection.document.scenes.map(s=>({sceneId:s.sceneId,index:s.index,name:s.name})),
    userRequest: request,
    currentFrame:profile.currentFrame,
    objectIndex: profile.objects.map(o => ({logicalObjectId:o.logicalObjectId, name:o.name, sourceInstances:o.sourceInstances})),
    // No geometry, full graph, unrelated history or implementation snippets.
    effectState: {
      ...(profile.effect==='anchor'?{anchorDefault:doc.state.anchorDefault??'legacy',anchors:doc.state.anchors?.filter(a=>ids.has(a.logicalObjectId))}:{}),
      dependencies:(doc.state.timingDependencies??[]).filter(d=>doc.state.animations.some(a=>owns(a.sceneId,a.targetId)&&(a.animationId===d.animationId||a.animationId===d.anchorAnimationId))),
      expressions: (doc.state.expressions ?? []).filter(e => e.type === profile.effect && (e.ownership?.logicalObjectId ? ids.has(e.ownership.logicalObjectId) : owns(e.sceneId,e.targetId))),
      rules: (doc.state.motionRules ?? []).filter(r => r.effect === profile.effect && (!r.scope.logicalObjectIds.length || r.scope.logicalObjectIds.some(id => ids.has(id)))),
      ...(profile.effect === 'inertialOvershoot'||profile.effect==='motion' ? {
        animations: doc.state.animations.filter(a => owns(a.sceneId,a.targetId)),
        transitions: (doc.state.objectTransitions ?? []).filter(t => ids.has(t.logicalObjectId)),
      } : {}),
    },
    skill: ruleSkills.filter(s => s.id === (profile.effect==='anchor'?'motion.anchor':profile.effect === 'wiggle' ? 'motion.continuous-wiggle' : 'motion.inertia-after-movement')).map(({id,version,description,defaults,constraints}) => ({id,version,effect:profile.effect,description,defaults,constraints})),
    constraints: {allowedLogicalObjectIds:[...ids], preserveUnrequestedProperties:true, preserveOtherEffects:true},
  };
}
/** Closed, fully consumed grammar only. Any extra modifier/unknown target falls back to semantic interpretation. */
export function deterministicIncrementalEdit(project: LoadedProject, request: string, doc?:MotionDocument,editor?:Parameters<typeof incrementalEditProfile>[3]): SemanticEdit | null {
  const profile = incrementalEditProfile(project, request,doc,editor);
  if (!profile) return null;
  if(profile.effect==='anchor')return parseAnchorEdit(request,profile.objects,editor);
  const referencedRule=doc?.state.motionRules?.find(r=>request.includes(r.ruleId));
  const chars = request.split('');
  if(referencedRule){const at=request.indexOf(referencedRule.ruleId);chars.fill(' ',at,at+referencedRule.ruleId.length);}
  for (const o of profile.objects) for (const range of objectMentionRanges(o.name, request)) chars.fill(' ', range.start, range.end);
  if(/-\s*\d/u.test(request))return null;
  const rest = chars.join('').replace(/после (?:завершения|конца) (?:каждого )?движени[йя]|после движени[йя]/giu,'').replace(/у выделенных объектов|всем зв[её]здам/giu,'').toLowerCase().replace(/(\d)[.,](?=\d)/gu,'$1§').replace(/[,.!—–-]/g,' ').replace(/§/g,'.').replace(/ё/g,'е').replace(/немножко/gu,'немного').replace(/сильно/gu,'значительно').replace(/\s+/g,' ').trim();
  if(profile.effect==='motion'){
    const scope={selector:'objects',phase:/появ/u.test(rest)?'entrance':'all'};
    const shift=rest.match(/^(?:пусть\s+)?(?:появляется|появляются|появление|начинается|начинаются|начало) на (\d+) (?:кадр|кадра|кадров|frames?) (позже|раньше)$/u);
    if(shift)return semanticEditSchema.parse({operation:'SHIFT_START',effect:'motion',targets:profile.objects.map(o=>o.logicalObjectId),scope,parameters:{},deltaFrames:Number(shift[1])*(shift[2]==='раньше'?-1:1),dependencyPolicy:'preserve-relative'});
    const duration=rest.match(/^(?:пусть\s+|сделай\s+)?(?:появление|появляется|появляются|движение|движения) (?:в (два|\d+(?:\.\d+)?) раза|вдвое) (медленнее|быстрее)$/u);
    if(duration){const n=duration[1]===undefined||duration[1]==='два'?2:Number(duration[1]);if(n>0&&n<=10)return semanticEditSchema.parse({operation:'SCALE_DURATION',effect:'motion',targets:profile.objects.map(o=>o.logicalObjectId),scope,parameters:{},durationFactor:duration[2]==='медленнее'?n:1/n});}
  }
  const decay=rest.match(/^(?:пусть\s+|сделай\s+)?(?:инерция|инерции|колебания) затухает (быстрее|медленнее)$/u);
  if(decay&&profile.effect==='inertialOvershoot')return semanticEditSchema.parse({operation:'MODIFY_PARAMETER',effect:profile.effect,targets:profile.objects.map(o=>o.logicalObjectId),scope:{selector:'objects',phase:'all'},parameters:{},decayFactor:decay[1]==='быстрее'?localModifierPolicy.faster:localModifierPolicy.slower});
  const absolute=rest.match(/^(?:сделай |измени |установи )?(?:у )?(амплитуд[ау]|частот[ау]|затухание) (?:на |равной |равным )?(\d+(?:\.\d+)?)$/u);
  if(absolute&&profile.effect!=='motion')return semanticEditSchema.parse({operation:'MODIFY_PARAMETER',effect:profile.effect,targets:profile.objects.map(o=>o.logicalObjectId),scope:{selector:'objects',phase:'all'},parameters:{[absolute[1].startsWith('амплитуд')?'amplitude':absolute[1].startsWith('частот')?'frequency':'decay']:Number(absolute[2])}});
  const compound=/амплитуд/u.test(rest)&&/частот/u.test(rest);
  // Independent qualitative axes must not collapse into the last matched factor.
  if(!compound&&/слабее|послабее|сильнее|посильнее/u.test(rest)&&/быстрее|медленнее/u.test(rest))return null;
  if(!compound&&(rest.match(/(?:сделай|уменьши|увеличь|измени|добавь|добавить|убери|удали|включи|отключи)/gu)?.length??0)>1)return null;
  let operation: SemanticEdit['operation'];
  const parameters:SemanticEdit['parameters']={};
  let amplitudeFactor:number|undefined,frequencyFactor:number|undefined,durationFactor:number|undefined;
  // Every word must be consumed: unknown modifiers/negations require compact semantic interpretation.
  const known=/^(?:сделай|уменьши|увеличь|измени|добавь|добавить|убери|удали|включи|отключи|у|на|к|и|в|два|раза|раз|эффект|эффекта|колебаний|колебания|колебание|затухающие|затухающих|затухающего|затухающее|инерцию|инерции|покачивание|покачивания|постоянного|постоянное|постоянный|wiggle|амплитуду|амплитуды|частоту|частоты|движения|движений|все|только|еще|чуть|немного|значительно|гораздо|намного|слабее|послабее|сильнее|посильнее|вдвое|медленнее|быстрее|объекты|объектам|объектов|правило|правила|исключение|исключения|из|для|линейный|линейное|изинг|easing|linear|easeInOutCubic|easeInCubic|easeOutCubic|\d+(?:\.\d+)?%?)$/iu;
  if(!rest.split(' ').every(word=>known.test(word)))return null;
  if(compound){
    if(!['wiggle','inertialOvershoot'].includes(profile.effect)||/добав|убери|удали|включи|отключи|быстрее|медленнее|правил|исключени/u.test(rest))return null;
    const factors=compoundParameterFactors(rest);if(!factors)return null;
    operation='MODIFY_PARAMETER';({amplitudeFactor,frequencyFactor}=factors);
  }
  else if(referencedRule&&/исключени/u.test(rest)&&/^(?:добавь|убери|удали)/u.test(rest))operation=/^добавь/u.test(rest)?'ADD_EXCEPTION':'REMOVE_EXCEPTION';
  else if(referencedRule&&/правил/u.test(rest)&&/^(?:убери|удали)/u.test(rest))operation='REMOVE_RULE';
  else if(/^добавь/u.test(rest)&&/правило/u.test(rest))operation='ADD_RULE';
  else if (/^(?:добавь|добавить)/u.test(rest)&&(profile.effect==='inertialOvershoot'||profile.effect==='wiggle'&&/постоянн|wiggle|покач/u.test(rest))) operation='ADD_EFFECT';
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
    if(!(doc.state.expressions??[]).some(e=>e.type===profile.effect&&(e.ownership?.logicalObjectId?ids.has(e.ownership.logicalObjectId):profile.objects.some(o=>o.sourceInstances.some(i=>i.sceneId===e.sceneId&&i.sourceNodeId===e.targetId))))&&!(doc.state.motionRules??[]).some(r=>r.effect===profile.effect&&(!r.scope.logicalObjectIds.length||r.scope.logicalObjectIds.some(id=>ids.has(id)))))throw Error('NO_MATCHING_EXISTING_EFFECTS');
  }
  return semanticEditSchema.parse({operation,effect:profile.effect,...(operation==='ADD_EFFECT'&&profile.effect==='wiggle'&&/wiggle/u.test(rest)&&!/постоянн|покач/u.test(rest)?{effectStorage:'expression'}:{}),...(referencedRule?{ruleId:referencedRule.ruleId}:{}),targets:profile.objects.map(o=>o.logicalObjectId),scope:{selector:'objects',phase:'all'},parameters,...(amplitudeFactor!==undefined?{amplitudeFactor}:{}),...(frequencyFactor!==undefined?{frequencyFactor}:{}),...(durationFactor!==undefined?{durationFactor}:{})});
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
  return normalizeSemanticGraph({schemaVersion:'semantic-graph/1.0',clauses:[{clauseId:'edit',text:request}],actions:edits.map((edit,i)=>({actionId:'edit_'+i,clauseId:'edit',kind:'editAnimation',scene:c.objectIndex.find(o=>o.logicalObjectId===edit.targets[0])!.sourceInstances[0].sceneId,constraints:[],unresolvedReason:null,targets:[c.objectIndex.find(o=>o.logicalObjectId===edit.targets[0])!.sourceInstances[0].sourceNodeId],techniques:[edit.effect === 'motion' ? 'customCurve' : edit.effect === 'easing'||edit.effect==='anchor' ? 'customCurve' : edit.effect === 'fade' ? 'fadeIn' : edit.effect],relation:'unchanged',parameters:[],semanticEdit:edit})),assumptions},incrementalGraphContext(context),request);
}

/** Read-only disclosures are computed from authoritative state, only for admitted IDs. */
export function incrementalDisclosure(project:LoadedProject,doc:MotionDocument,profile:NonNullable<ReturnType<typeof incrementalEditProfile>>,queries:z.infer<typeof incrementalQuerySchema>[]){
 const context=incrementalContext(project,doc,'',profile);
 return queries.map(q=>{const object=profile.objects.find(o=>o.logicalObjectId===q.logicalObjectId);if(!object)throw Error('INCREMENTAL_SCOPE_VIOLATION');const owns=(s:string,t:string)=>object.sourceInstances.some(i=>i.sceneId===s&&i.sourceNodeId===t);
 const data=q.kind==='inspectObject'?object:q.kind==='inspectAnimations'?doc.state.animations.filter(a=>owns(a.sceneId,a.targetId)):q.kind==='inspectExpressions'?(doc.state.expressions??[]).filter(e=>owns(e.sceneId,e.targetId)):q.kind==='inspectMotionRules'?context.effectState.rules:q.kind==='inspectSceneStates'?object.states:context.effectState.dependencies;
 const result={query:q,data};if(Buffer.byteLength(JSON.stringify(result))>16000)throw Error('CONTEXT_DISCLOSURE_BUDGET');return result;});
}

export type incrementalQuery=z.infer<typeof incrementalQuerySchema>;
