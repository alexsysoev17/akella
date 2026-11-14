import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {codexBinary} from '../harness/providers/codex.js';

const allowed=['list_models','get_model_schema','get_upload_url','generate_image','get_job'] as const;
type Operation=typeof allowed[number];
export function mcpValue(r:any):any {
  if(r?.isError)throw Error(r.content?.filter((x:any)=>x.type==='text').map((x:any)=>x.text).join('\n')||'Krea MCP error');
  if(r?.structuredContent)return r.structuredContent;
  const text=r?.content?.filter((x:any)=>x.type==='text').map((x:any)=>x.text).join('\n');
  try{return JSON.parse(text);}catch{return {text};}
}
/** Same supported app-server transport used by Figma. No token extraction or API-key copy. */
export class KreaConnection {
  private child?:ChildProcessWithoutNullStreams;
  private seq=0;private threadId='';
  private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  async connect(cwd:string){
    this.child=spawn(await codexBinary(),['app-server','-c','mcp_servers={}'],{stdio:'pipe'});
    this.child.stderr.resume();this.child.on('error',()=>this.fail('Codex connection unavailable'));
    this.child.on('exit',()=>this.fail('Codex connection closed'));this.child.stdin.on('error',()=>this.fail('Codex connection closed'));
    createInterface({input:this.child.stdout}).on('line',line=>{
      let m:any;try{m=JSON.parse(line);}catch{return;}
      if(m.method&&m.id!==undefined){this.child?.stdin.write(JSON.stringify({id:m.id,error:{code:-32601,message:'Interactive requests require user action in Codex'}})+'\n');return;}
      const p=this.pending.get(m.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(m.id);
      if(m.error)p.reject(Error(m.error.message||'Codex RPC error'));else p.resolve(m.result);
    });
    await this.rpc('initialize',{clientInfo:{name:'akella-banners',version:'1.0.0'},capabilities:{experimentalApi:true}});
    this.child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
    this.threadId=(await this.rpc('thread/start',{cwd,approvalPolicy:'never',sandbox:'read-only',ephemeral:true})).thread.id;
    const status=await this.rpc('mcpServerStatus/list',{threadId:this.threadId,detail:'toolsAndAuthOnly',serverName:'codex_apps'});
    if(!status.data?.some((s:any)=>s.tools?.['krea.generate_image']))throw Error('Подключи Krea в Codex, затем повтори запрос.');
  }
  private rpc(method:string,params:unknown):Promise<any>{return new Promise((resolve,reject)=>{
    const id=++this.seq,timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Krea не ответила вовремя'));},120000);
    this.pending.set(id,{resolve,reject,timer});this.child!.stdin.write(JSON.stringify({id,method,params})+'\n');
  });}
  private fail(message:string){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error(message));}this.pending.clear();}
  async call(name:Operation,args:Record<string,unknown>){
    if(!allowed.includes(name))throw Error('Unsupported Krea operation');
    const r=await this.rpc('mcpServer/tool/call',{threadId:this.threadId,server:'codex_apps',tool:'krea.'+name,arguments:args});
    return mcpValue(r);
  }
  close(){this.fail('Connection finished');this.child?.kill();}
}

/** Signed upload is returned by the connected provider, never chosen by the model. */
export async function uploadReference(connection:KreaConnection,file:string){
  const signed=await connection.call('get_upload_url',{});
  const raw=signed.upload_url??signed.uploadUrl??signed.url??signed.text?.match(/https:\/\/[^\s"<>]+/)?.[0];
  const url=new URL(raw);
  if(url.protocol!=='https:'||url.hostname!=='api.krea.ai')throw Error('Unexpected Krea upload host');
  const bytes=await readFile(file);if(bytes.length>30*1024*1024)throw Error('Reference is too large');
  const form=new FormData();form.append('file',new Blob([bytes]),'reference.png');
  const r=await fetch(url,{method:'POST',body:form,redirect:'error',signal:AbortSignal.timeout(60000)});
  if(!r.ok)throw Error('Krea upload HTTP '+r.status);
  const rawResponse=(await r.text()).trim();let data:any;
  try{data=JSON.parse(rawResponse);}catch{data=rawResponse;}
  const imageUrl=typeof data==='string'?data:data.image_url??data.url??data.asset?.image_url;
  if(typeof imageUrl!=='string'||!imageUrl.startsWith('https://'))throw Error('Krea did not return an asset URL');return imageUrl;
}
export async function generateKeyVisual(options:{cwd:string;prompt:string;references:string[];model:string;background?:'cutout'|'scene';
  onProgress:(message:string,jobId?:string)=>Promise<void>}){
  const c=new KreaConnection();
  try{
    await c.connect(options.cwd);
    const models=await c.call('list_models',{category:'image'});
    if(!models.models?.some((m:any)=>m.id===options.model))throw Error('Выбранная модель Krea недоступна');
    const schema=await c.call('get_model_schema',{model:options.model});
    if(!schema.inputSchema?.properties?.image_urls)throw Error('Модель не поддерживает стилевые референсы');
    const urls=[];for(const p of options.references)urls.push(await uploadReference(c,p));
    const input={prompt:`Create ONLY a standalone key visual asset. No banner, no advertising layout, no logo, no words, no prices. Preserve the visual language of the attached references. ${options.prompt}\n${options.background!=='scene'?'Isolated object on a plain solid white backdrop for local alpha extraction. Do NOT draw a checkerboard, grid or fake transparency. Full object silhouette within the frame.':''}`,image_urls:urls,aspect_ratio:'1:1'};
    const response=await c.call('generate_image',{model:options.model,input,sync:false});
    let job=response.job;const jobId=response.job_id??job?.job_id;
    if(!jobId)throw Error('Krea did not return a job ID');
    await options.onProgress('Krea создаёт отдельное изображение…',jobId);
    const end=Date.now()+10*60*1000;
    while(job?.status!=='completed'){
      if(['failed','cancelled'].includes(job?.status))throw Error(job.error?.message||'Krea generation failed');
      if(Date.now()>end)throw Error(`Krea ещё выполняет задачу ${jobId}; повторная генерация автоматически не запускается.`);
      await delay(3500);const result=await c.call('get_job',{jobId});job=result.job??result;
    }
    const url=job.result?.urls?.[0];if(typeof url!=='string')throw Error('Krea did not return an image');
    return {url,jobId,model:options.model,referenceUrls:urls};
  }finally{c.close();}
}
