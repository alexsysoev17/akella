import {readFile,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {workspace as root} from '../banners/workspace.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const data=path.join(root,'data/brands');
const idPattern=/^[a-z0-9][a-z0-9-]{0,63}$/;
export function brandDirectory(id:string){if(!idPattern.test(id))throw Error('Invalid brand');return path.join(data,id);}
async function fileInside(base:string,relative:string){const file=await realpath(path.resolve(base,relative));if(!file.startsWith(await realpath(base)+path.sep))throw Error('Unsafe brand file');return file;}
export async function listBrands(){
 let entries;try{entries=await readdir(data,{withFileTypes:true});}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
 const brands=[];
 for(const e of entries){if(!e.isDirectory()||!idPattern.test(e.name))continue;const catalog=JSON.parse(await readFile(await fileInside(brandDirectory(e.name),'catalog.json'),'utf8'));brands.push({id:e.name,name:catalog.name,coverage:catalog.coverage,snapshot:catalog.snapshot});}
 return brands;
}
export interface BrandSearchRequest {
 query:string; kind?:string; kinds?:string[]; limit?:number; mode?:'hybrid'|'lexical';
 filters?:{pageId?:string;familyId?:string;role?:string;channel?:string;audience?:string;polarity?:string;hasReferencePack?:boolean};
 targetFormat?:{width:number;height:number}; diversifyFamilies?:boolean;
}
/** One bounded process per retrieval plan; model sessions and verified hashes are reused within it. */
export async function searchBrandBatch(id:string,requests:BrandSearchRequest[]){
 brandDirectory(id);
 if(!Array.isArray(requests)||requests.length<1||requests.length>8)throw Error('Нужно от 1 до 8 поисковых запросов');
 if(requests.some(r=>typeof r.query!=='string'||!r.query.trim()||r.query.length>2000)||requests.reduce((sum,r)=>sum+r.query.length,0)>8000)throw Error('Слишком большой поисковый запрос');
 const input=JSON.stringify(requests);if(input.length>64000)throw Error('Слишком большой пакет поиска');
 const pending=promisify(execFile)(path.join(root,'data/knowledge/.venv/bin/python'),[path.join(root,'scripts/knowledge/brand_library.py'),'search-batch',id],
   {timeout:120000,maxBuffer:4*1024*1024,env:{...process.env,HF_HUB_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1'}});
 // Process errors/timeouts are reported by execFile; a closed input pipe must not crash the server.
 pending.child.stdin?.on('error',()=>{});
 pending.child.stdin?.end(input);
 const {stdout}=await pending;const response=JSON.parse(stdout);
 if(response.results?.length!==requests.length)throw Error('Неполный ответ поиска');
 return response.results as any[];
}
export async function searchBrand(id:string,query:string,kind?:string){
 return (await searchBrandBatch(id,[{query,...(kind?{kind}:{}),limit:8}]))[0];
}
export async function brandMedia(id:string,recordId:string){
 const base=brandDirectory(id),catalog=JSON.parse(await readFile(await fileInside(base,'catalog.json'),'utf8'));
 const records=JSON.parse(await readFile(await fileInside(base,catalog.records),'utf8')) as {id:string;status:string;evidence:{image?:string}[]}[];
 const r=records.find(r=>r.id===recordId&&r.status==='reviewed');const image=r?.evidence.find(e=>e.image)?.image;
 if(!image)throw Error('Изображение ещё не загружено');const file=await fileInside(base,image);
 const ext=path.extname(file).toLowerCase();const mime=({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'} as Record<string,string>)[ext];if(!mime)throw Error('Unsupported preview');return {file,mime};
}
