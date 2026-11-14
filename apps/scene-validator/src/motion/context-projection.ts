import { createHash } from 'node:crypto';

type FragmentRef = {$schemaFragment:string};
export interface SchemaCatalog {
  format:'exact-schema-fragments/1';
  instruction:string;
  fragments:Record<string,unknown>;
  schemas:[string,unknown][];
}
/** Lossless interning of repeated schema objects. No fields, enums or constraints disappear. */
export function exactSchemaCatalog(schemas:[string,unknown][]):SchemaCatalog {
  const counts=new Map<string,number>();
  const visit=(value:unknown)=>{
    if(!value||typeof value!=='object')return;
    if(!Array.isArray(value)){const json=JSON.stringify(value);if(json.length>=200)counts.set(json,(counts.get(json)??0)+1);}
    Object.values(value).forEach(visit);
  };
  schemas.forEach(([,schema])=>visit(schema));
  const fragments:Record<string,unknown>={};
  const encode=(value:unknown,root=false):unknown=>{
    if(!value||typeof value!=='object')return value;
    if(!root&&!Array.isArray(value)){
      const json=JSON.stringify(value);
      if((counts.get(json)??0)>1){
        const id='s_'+createHash('sha256').update(json).digest('hex').slice(0,20);
        if(!Object.hasOwn(fragments,id))fragments[id]=encode(value,true);
        return {$schemaFragment:id} satisfies FragmentRef;
      }
    }
    return Array.isArray(value)?value.map(v=>encode(v)):Object.fromEntries(Object.entries(value).map(([key,v])=>[key,encode(v)]));
  };
  const encoded=schemas.map(([key,schema])=>[key,encode(schema)] as [string,unknown]);
  return {format:'exact-schema-fragments/1',instruction:'This is a lossless schema dictionary, not tool arguments. Replace every object containing only $schemaFragment with fragments[that ID], recursively, to read the exact original schema. Original JSON Schema $ref/$defs retain their original meaning after expansion. Never send $schemaFragment in tool arguments. Every loaded tool schema remains available.',fragments,schemas:encoded};
}
/** Used by regression checks and diagnostic consumers; fails closed on corrupt references. */
export function expandSchemaCatalog(catalog:SchemaCatalog):[string,unknown][] {
  const expand=(value:unknown,stack=new Set<string>()):unknown=>{
    if(!value||typeof value!=='object')return value;
    if(!Array.isArray(value)&&Object.keys(value).length===1&&'$schemaFragment'in value){
      const id=(value as FragmentRef).$schemaFragment;
      if(!Object.hasOwn(catalog.fragments,id)||stack.has(id))throw Error('INVALID_SCHEMA_FRAGMENT');
      return expand(catalog.fragments[id],new Set([...stack,id]));
    }
    return Array.isArray(value)?value.map(v=>expand(v,stack)):Object.fromEntries(Object.entries(value).map(([k,v])=>[k,expand(v,stack)]));
  };
  return catalog.schemas.map(([key,schema])=>[key,expand(schema)]);
}

export function isCandidateObservation(tool?:string){return !!tool&&(tool.startsWith('inspect')||['renderFrame','renderFrameSequence','compareFrames','sampleAnimation','evaluateObjectAtTime','runFocusedQA'].includes(tool));}
/** Old frame geometry describes an older candidate, not the current one. Keep its provenance. */
export function archivedObservation(result:unknown,tool:string,observedDigest:string){
  const frames=Array.isArray(result)?result:[];
  const report=result&&!Array.isArray(result)&&typeof result==='object'?result as Record<string,unknown>:undefined;
  return {status:'STALE_OBSERVATION',observedCandidateDigest:observedDigest,reloadWith:tool,
    artifacts:frames.filter(v=>v&&typeof v==='object').map((v:any)=>Object.fromEntries(['frame','artifact','pixelHash','width','height'].filter(k=>v[k]!==undefined).map(k=>[k,v[k]]))),
    ...(report?{previousStatus:report.status,summary:report.summary,failedChecks:Array.isArray(report.checks)?report.checks.filter((c:any)=>c.status==='FAILED').map((c:any)=>Object.fromEntries(['id','checkId','kind','status','message','reason'].filter(k=>c[k]!==undefined).map(k=>[k,c[k]]))):undefined}:{}),
    details:'Previous-candidate observation. Full numeric/geometry evidence remains in the durable tool trace; render/sample the current candidate before judging it.'};
}

/** Exact stable material is placed before mutable observations to permit prefix caching. */
export function projectAgentContext(userRequest:string,catalog:SchemaCatalog,dynamic:Record<string,unknown>){
  return JSON.stringify({userRequest,toolSchemaCatalog:catalog,...dynamic});
}
