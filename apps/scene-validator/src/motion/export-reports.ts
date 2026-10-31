import {readFile,readdir,stat} from 'node:fs/promises';import path from 'node:path';
import {noSymlinkPath,within} from '../files.js';
export async function exportReport(root:string,id:string){if(!/^[a-f0-9-]{36}$/i.test(id))throw Error('INVALID_EXPORT_JOB_ID');const file=within(root,'motion/exports/'+id+'/report.json');await noSymlinkPath(root,file);if((await stat(file)).size>2000000)throw Error('EXPORT_DIAGNOSTIC_SIZE');return JSON.parse(await readFile(file,'utf8'));}
export async function exportReports(root:string){const dir=within(root,'motion/exports');await noSymlinkPath(root,dir);let names:string[];try{names=await readdir(dir);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
 const rows=await Promise.all(names.filter(n=>/^[a-f0-9-]{36}$/i.test(n)).map(async id=>{const file=within(dir,id+'/report.json');await noSymlinkPath(root,file);try{return {id,time:(await stat(file)).mtimeMs};}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}));
 return Promise.all(rows.filter((v):v is {id:string;time:number}=>v!==null).sort((a,b)=>b.time-a.time).slice(0,20).map(r=>exportReport(root,r.id)));
}
