import {effectiveMotionModel} from './model-policy.js';
export type ModelRole='director'|'worker'|'lightweight'|'general';
/** Only explicit role preferences authorize fallback. A cached catalogue is not entitlement. */
export async function resolveProductionModels(settings:{provider:string;model:string;reasoningEffort?:'low'|'medium'|'high'},config:Partial<Record<ModelRole,string[]>>={},excluded:string[]=[],_environment:{codexHome?:string;now?:number}={}){
 const defaults=effectiveMotionModel(settings);
 const pick=(role:ModelRole)=>{
  const requested=config[role]??[defaults.model],model=requested.find(id=>!excluded.includes(id));
  if(model===undefined)throw Error('PRODUCTION_MODEL_FALLBACK_UNAVAILABLE: no explicitly permitted model remains');
  return {role,provider:settings.provider,model,reasoningEffort:defaults.reasoningEffort,provenance:config[role]?'EXPLICIT_ROLE_POLICY':'APPLICATION_OR_USER_SELECTION',availability:'UNVERIFIED_CONFIGURED',fallback:model!==requested[0],diagnostics:model!==requested[0]?['Explicit role fallback selected: '+model]:[]};
 };
 return {general:pick('general'),director:pick('director'),worker:pick('worker'),lightweight:pick('lightweight')};
}
