import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {access} from 'node:fs/promises';
const root=new URL('../../../../',import.meta.url);
/** Explicit opt-in collection; no cross-brand auto-search and no model-supplied file paths. */
export async function searchBrandKnowledge(query:string,limit=5,signal?:AbortSignal,mode:'hybrid'|'dense'|'lexical'='hybrid'){
 const python=fileURLToPath(new URL('data/knowledge/.venv/bin/python',root));
 const script=fileURLToPath(new URL('scripts/knowledge/brandbook.py',root));
 const db=fileURLToPath(new URL('data/knowledge/x5-brandbook/hybrid.sqlite',root));
 try {await access(python);await access(db);}catch{return {status:'NOT_CONFIGURED',collection:'x5-brandbook',results:[]};}
 const {stdout}=await promisify(execFile)(python,[script,'search',query,'--limit',String(limit),'--mode',mode],{timeout:60000,maxBuffer:128*1024,signal,env:{...process.env,HF_HUB_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1'}});
 return JSON.parse(stdout);
}
