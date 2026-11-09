import {createHash} from 'node:crypto';
import {readdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

/** Captured at module initialization, not when an Inspector report reads disk.
 * No watcher, process killing or automatic retries. Existing runs may finish. */
export class RuntimeCodeGuard {
 readonly startedAt=new Date().toISOString();
 private readonly loaded:Map<string,string>;
 constructor(private root:string){this.loaded=this.snapshot();}
 private snapshot(){
  const files=readdirSync(this.root,{recursive:true,withFileTypes:true})
   .filter(e=>e.isFile()&&/\.(?:ts|js|mjs)$/.test(e.name))
   .map(e=>path.join(e.parentPath,e.name)).sort();
  return new Map(files.map(f=>[path.relative(this.root,f),createHash('sha256').update(readFileSync(f)).digest('hex')]));
 }
 status(){
  const current=this.snapshot();
  const changedFiles=[...new Set([...this.loaded.keys(),...current.keys()])].filter(f=>this.loaded.get(f)!==current.get(f));
  return {status:changedFiles.length?'RESTART_REQUIRED':'CURRENT',pid:process.pid,startedAt:this.startedAt,
   loadedCodeDigest:createHash('sha256').update(JSON.stringify([...this.loaded])).digest('hex'),changedFiles};
 }
 assertCurrent(){
  if(this.status().status!=='CURRENT')throw Object.assign(Error('Сервер AKELLA работает со старой версией кода. Перезапустите сервер перед новым запросом. ИИ не вызывался, проект не изменён.'),{code:'SERVER_RESTART_REQUIRED'});
 }
}
export const runtimeCode=new RuntimeCodeGuard(fileURLToPath(new URL('./',import.meta.url)));
