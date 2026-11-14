import {mkdir,readFile,writeFile,rename,realpath,readdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import type {BannerProject} from './contracts.js';
import {workspace} from './workspace.js';
export const bannerRoot=path.join(workspace,'data/banner-projects');
export const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
export function projectDirectory(id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw Error('Invalid banner project');return path.join(bannerRoot,id);}
export async function containedFile(base:string,relative:string){const dir=await realpath(base),file=await realpath(path.resolve(dir,relative));
  if(!file.startsWith(dir+path.sep))throw Error('Unsafe banner resource');return file;}
export async function atomic(file:string,value:unknown){const tmp=file+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2));await rename(tmp,file);}
export async function saveProject(p:BannerProject){p.updatedAt=new Date().toISOString();await atomic(path.join(projectDirectory(p.id),'project.json'),p);}
export async function readProject(id:string):Promise<BannerProject>{return JSON.parse(await readFile(await containedFile(projectDirectory(id),'project.json'),'utf8'));}
/** Revision context follows the document's commit pointer; root context is a legacy fallback only. */
export async function readBannerContext(p:Pick<BannerProject,'id'|'revision'>){
  const base=projectDirectory(p.id);
  try{return JSON.parse(await readFile(await containedFile(base,`revisions/${p.revision}/brand-context.json`),'utf8'));}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  return JSON.parse(await readFile(await containedFile(base,'brand-context.json'),'utf8'));
}
export async function listProjects(){await mkdir(bannerRoot,{recursive:true});const out=[];
  for(const e of await readdir(bannerRoot,{withFileTypes:true})){if(!e.isDirectory()||!/^[a-f0-9-]{36}$/.test(e.name))continue;
    try{const p=await readProject(e.name);out.push({id:p.id,title:p.title,brand:p.brand,updatedAt:p.updatedAt,revision:p.revision});}catch{/* Incomplete staging directories are not projects. */}}
  return out.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
}
export async function recoverBannerJobs(){for(const info of await listProjects()){const p=await readProject(info.id);if(p.job?.status==='running'){
  p.job={...p.job,status:'failed',stage:'Запуск прерван перезапуском сервера',error:'Сохранённые макеты не изменены. Повтори запрос.'};await saveProject(p);
}}}
