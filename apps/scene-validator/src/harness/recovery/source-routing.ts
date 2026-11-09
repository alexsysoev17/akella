import type {RecoveryFailure} from './failure.js';
/** Read/write scope for HUMAN-REVIEWED patches, independent of failure-code eligibility.
 * Secrets, approval/confinement code and arbitrary project files remain excluded. */
export function repairSourceReadable(file:string){return /^apps\/scene-validator\/src\/[a-zA-Z0-9/_-]+\.ts$/.test(file);}
export function repairSourceAllowed(file:string){return repairSourceReadable(file)&&!/(?:^|\/)(?:security|promotion|code-repair)\.ts$/.test(file);}
export function codeSources(failure:RecoveryFailure){
 const text=[failure.stage,failure.code,failure.invariant,...failure.evidence.map(e=>e.detail)].join('\n');
 const stack=[...text.matchAll(/apps[\\/]scene-validator[\\/]src[\\/][a-zA-Z0-9/_-]+\.ts/g)].map(m=>m[0].replaceAll('\\','/')).filter(repairSourceReadable);
 const contexts=[
  [/context|CONTEXT/,["harness/context-packing","harness/providers/budget","harness/context","harness/semantic-context","harness/runtime"]],
  [/coverage|COVERAGE|VALIDATOR/,["motion/intent/coverage","motion/intent/planner","motion/intent/repair","motion/intent/provenance"]],
  [/provider|PROVIDER|schema|OUTPUT|INVALID_OUTPUT/,["harness/providers/codex","harness/providers/schema","motion/provider","motion/intent/planner"]],
  [/semantic|planning/,["motion/intent/planner","motion/intent/repair","motion/intent/schema","motion/intent/graph"]],
  [/resolv|reference|TARGET|OBJECT/,["motion/object-resolution","motion/contextual-resolution","motion/intent/planner"]],
  [/render|RENDER|SKIA/,["native/renderer","native/client","native/qa","native/paths"]],
  [/qa|QA/,["native/qa","motion/qa/policy","motion/qa/failure","harness/qa"]],
  [/recovery|repair|RECOVERY/,["harness/recovery/runtime","harness/recovery/semantic","harness/recovery/provider-runtime","harness/recovery/code-service","harness/recovery/supervisor"]],
  [/reconcil|RECONCIL|execution|operation/,["motion/intent/execution","motion/operations","motion/intent/compiler","motion/service"]],
 ] as const;
 const localized=/SEMANTIC_COVERAGE|REPAIR_(?:SOURCE_|FIELD_)?SCOPE_VIOLATION/.test(failure.code)?["motion/intent/coverage","motion/intent/temporal-evidence","motion/intent/repair","motion/intent/provenance"].map(f=>"apps/scene-validator/src/"+f+".ts"):[];
 const selected=[...localized,...stack,...contexts.filter(([pattern])=>pattern.test(text)).flatMap(([,files])=>files.map(f=>'apps/scene-validator/src/'+f+'.ts'))];
 if(!selected.length)selected.push('apps/scene-validator/src/motion/service.ts','apps/scene-validator/src/motion/intent/compiler.ts','apps/scene-validator/src/motion/intent/execution.ts');
 return [...new Set(selected)].filter(repairSourceReadable).slice(0,5);
}
