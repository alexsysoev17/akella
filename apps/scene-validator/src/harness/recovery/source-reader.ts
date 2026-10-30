import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {noSymlinkPath,within} from '../../files.js';
import {redactSecrets} from '../security.js';
import type {CodeRepairWorkspace} from './code-repair.js';
import {repairSourceAllowed,repairSourceReadable} from './source-routing.js';
export interface SourceQuery {kind:'read'|'search'|'callers'|'tests';path?:string|null;query?:string|null;startLine?:number|null;endLine?:number|null;}
/** Reads only the frozen isolated source snapshot. No shell, project files, network or writes. */
export async function readRepairSources(workspace:CodeRepairWorkspace,queries:SourceQuery[],byteLimit:number){
 if(queries.length>12)throw Error('CODE_SOURCE_QUERY_LIMIT');
 const permitted=(p:string)=>repairSourceReadable(p)||/^apps\/scene-validator\/tests\/[a-zA-Z0-9/_-]+\.(?:test|browser)\.ts$/.test(p);
 const files=(await readdir(path.join(workspace.root,'apps/scene-validator'),{recursive:true})).map(p=>'apps/scene-validator/'+p).filter(permitted).sort();
 const results:unknown[]=[];let bytes=0;
 for(const q of queries){
  // A directory query is a bounded search over permitted files, never an
  // expansion of filesystem permissions (or a request to read a directory).
  const directory=q.path&&q.kind!=='read'&&/^apps\/scene-validator\/(?:src|tests)(?:\/[a-zA-Z0-9_-]+)*\/?$/.test(q.path)?q.path.replace(/\/$/,''):null;
  if(q.path&&!directory&&!permitted(q.path))throw Error('CODE_SOURCE_READ_SCOPE');
  const candidates=(directory?files.filter(p=>p.startsWith(directory+'/')):q.path?[q.path]:files).filter(p=>q.kind!=='tests'||p.includes('/tests/'));
  const matches:unknown[]=[];
  for(const rel of candidates){
   const file=within(workspace.root,rel);await noSymlinkPath(workspace.root,file);
   const text=await readFile(file,'utf8');if(Buffer.byteLength(text)>2000000)continue;
   if(redactSecrets(text)!==text){matches.push({path:rel,status:'REDACTED_SENSITIVE_SOURCE'});continue;}
   const lines=text.split('\n');
   const indices=q.kind==='read'?[Math.max(0,(q.startLine??1)-1)]:lines.flatMap((line,i)=>q.query&&line.includes(q.query)?[i]:[]).slice(0,8);
   if(!indices.length)continue;
   const spans=indices.map(i=>{const start=q.kind==='read'?i:Math.max(0,i-6),end=q.kind==='read'?Math.min(lines.length,q.endLine??start+100,start+250):Math.min(lines.length,i+15);return {startLine:start+1,endLine:end,content:lines.slice(start,end).join('\n')};});
   const result={path:rel,hash:createHash('sha256').update(text).digest('hex'),totalLines:lines.length,spans,sourceWriteAllowed:repairSourceAllowed(rel)};
   const size=Buffer.byteLength(JSON.stringify(result));if(bytes+size>byteLimit){matches.push({path:rel,status:'SOURCE_READ_BYTE_BUDGET',availableBytes:byteLimit-bytes});break;}
   bytes+=size;matches.push(result);
   if(repairSourceAllowed(rel)&&!workspace.files.some(f=>f.path===rel))workspace.files.push({path:rel,hash:result.hash,content:text});
   if(matches.length>=12)break;
  }
  results.push({query:q,matches,status:matches.length?'READ':'NO_MATCH'});
 }
 return {results,bytes,byteLimit};
}
