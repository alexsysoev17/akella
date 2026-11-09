import {chromium} from 'playwright';
import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {createRequire} from 'node:module';import path from 'node:path';
import {identityFixture,node} from './identity-fixture.js';import {servePlatform} from '../src/platform-server.js';import {readMotion,changeMotion} from '../src/motion/store.js';import {renderProjectFrame} from '../src/native/service.js';import {closeNativeRenderer} from '../src/native/client.js';import {exportVideo} from '../src/motion/video.js';
process.env.AKELLA_RENDERER='native';
test('HTTP settings transaction → native late frame → actual encoded FPS/duration/frame count → shrink/reopen and safe stale revision',async()=>{
 const f=await identityFixture(1,s=>s[0].children=[node('n','Circle',20,30,25,25)]);let server:Awaited<ReturnType<typeof servePlatform>>|undefined;
 try{
 let doc=await readMotion(f.project);
 doc=(await changeMotion(f.project.root,{expectedRevision:doc.revision,request:'fixture',operations:[{type:'setProjectTime',durationSeconds:8,fps:30},{type:'addAnimation',animation:{animationId:'move',sceneId:'s0',targetId:'n',effect:'moveTo',parameters:{fromX:0,fromY:0,toX:80,toY:0},startFrame:60,durationFrames:30,easing:'linear',enabled:true}}]})).document;
 const original=structuredClone(doc.state.animations);
 server=await servePlatform(path.dirname(f.project.root),0);const port=(server.address() as {port:number}).port,base=`http://127.0.0.1:${port}/api/projects/${f.project.config.projectId}/motion`;
 const settings=async(seconds:number,fps:number)=>{const r=await fetch(base+'/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:doc.revision,durationSeconds:seconds,fps,width:200,height:120})});assert.equal(r.status,200,await r.clone().text());return r.json();};
 const oldRevision=doc.revision;let result=await settings(10,30);doc=result.document;assert.equal(result.time.durationFrames,300);assert.deepEqual(doc.state.animations,original);
 doc=(await changeMotion(f.project.root,{expectedRevision:doc.revision,request:'late motion',operations:[{type:'addAnimation',animation:{...original[0],animationId:'late',startFrame:270,durationFrames:21,parameters:{fromX:80,fromY:0,toX:130,toY:0}}}]})).document;
 const before=await renderProjectFrame(f.project,280,{encoding:'rgba'});
 result=await settings(10,60);doc=result.document;
 assert.equal(doc.state.animations.find((a:any)=>a.animationId==='late')!.startFrame,540);
 assert.deepEqual((await renderProjectFrame(f.project,560,{encoding:'rgba'})).png,before.png);
 const video=await exportVideo(f.project.root,()=>{},{renderer:'native'});assert.equal(video.frames,600);
 const middle=await renderProjectFrame(f.project,300,{encoding:'rgba'});assert.ok('frameDigests' in video);assert.equal(video.frameDigests.find(d=>d.frame===300)?.sha256,createHash('sha256').update(middle.png).digest('hex'));
 const ffmpeg=createRequire(import.meta.url)('ffmpeg-static');const decoded=await promisify(execFile)(ffmpeg,['-hide_banner','-i',path.join(f.project.root,'renders',video.file),'-f','null','-']);
 assert.match(decoded.stderr,/60 fps/);assert.match(decoded.stderr,/Duration: 00:00:10\.00/);assert.match(decoded.stderr,/frame=\s*600/);
 result=await settings(8,60);doc=result.document;assert.ok(result.warnings.length);assert.equal((await readMotion(f.project)).state.animations.length,2);
 const stale=await fetch(base+'/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:oldRevision,durationSeconds:10,fps:30,width:200,height:120})});assert.ok(stale.status>=400);
 assert.equal((await readMotion(f.project)).revision,doc.revision);
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${port}/#project/${f.project.config.projectId}`);
  await page.locator('#m-open-settings').click();await page.locator('#m-seconds').fill('15');await page.locator('#m-fps').fill('25');
  const response=page.waitForResponse(r=>r.url().endsWith('/motion/settings')&&r.request().method()==='POST');await page.locator('#m-settings').click();assert.equal((await response).status(),200);
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('#m-scrub')?.max==='374');
  assert.equal(await page.locator('#m-seconds').inputValue(),'15');assert.equal(await page.locator('#m-fps').inputValue(),'25');
  const stored=await readMotion(f.project);assert.equal(stored.state.settings.durationFrames,375);assert.equal(stored.state.settings.fps,25);
  assert.match(await page.locator('#m-time').innerText(),/15\.00/);
  await page.locator('#m-frame').fill('50');await page.locator('#m-frame').dispatchEvent('change');
  await page.locator('#m-undo').click();await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('#m-fps')?.value==='60');
  assert.equal(await page.locator('#m-frame').inputValue(),'120','Undo restores FPS while preserving playhead seconds');
  await page.locator('#m-redo').click();await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('#m-fps')?.value==='25');
  assert.equal(await page.locator('#m-frame').inputValue(),'50');

 }finally{await browser.close();}

 }finally{if(server)await new Promise<void>(r=>server!.close(()=>r()));await closeNativeRenderer();await f.cleanup();}
});

test('settings changed during a provider call cannot mix revisions or commit old motion into the new timebase',async()=>{
 const {registerProvider}=await import('../src/harness/providers/index.js');const {executeMotion}=await import('../src/motion/service.js');const {objectRequirement}=await import('./intent-fixture.js');const {readFile,readdir}=await import('node:fs/promises');
 const f=await identityFixture(1,s=>s[0].children=[node('n','Circle',20,30,25,25)]);
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
 const text='Circle появляется через фейд на 2 секунде';const r=objectRequirement('a','s0','n','Circle',['fadeIn'],text);r.timing.startSeconds=2;
 const stop=registerProvider('time-concurrency',()=>({id:'time-concurrency',mode:'mock',capabilities:()=>({structuredOutput:true,nativeToolCalling:false,cancellation:true,usage:false,nativeOutputTokenLimit:false}),generate:async()=>{entered();await gate;return {output:{schemaVersion:'1.0.0',requirements:[r],coverage:[{sourceText:text,requirementIds:['a'],classification:'executable',explanation:'fixture'}],assumptions:[]},usage:null,estimatedCost:null,latencyMs:0,diagnostics:[],toolCalls:[]};}}));
 try{
 let doc=await readMotion(f.project);doc=(await changeMotion(f.project.root,{expectedRevision:doc.revision,request:'initial',operations:[{type:'setProjectTime',durationSeconds:8,fps:30}]})).document;
 const execution=executeMotion(f.project,{mode:'create',request:text,expectedRevision:doc.revision,settings:{provider:'time-concurrency',model:''}},()=>{},{config:{maxLLMCalls:1,maxRepairAttempts:0}});const outcome=execution.then(value=>({value,error:null}),error=>({value:null,error}));
 await started;
 const changed=await changeMotion(f.project.root,{expectedRevision:doc.revision,request:'new settings',operations:[{type:'setProjectTime',durationSeconds:10,fps:60}]});release();
 const result=await outcome;assert.ok(result.error,JSON.stringify(result.value));assert.match(String(result.error),/изменил|измени|STALE|Анимация/);
 const after=await readMotion(f.project);assert.equal(after.revision,changed.document.revision);assert.equal(after.state.settings.fps,60);assert.equal(after.state.settings.durationFrames,600);assert.equal(after.state.animations.length,0);
 const run=(await readdir(path.join(f.project.root,'motion/ai')))[0],ctx=JSON.parse(await readFile(path.join(f.project.root,'motion/ai',run,'context.json'),'utf8'));
 assert.equal(ctx.projectRevision,doc.revision);assert.equal(ctx.project.time.projectRevision,doc.revision);assert.equal(ctx.project.time.fps,30);assert.equal(ctx.project.time.durationFrames,240);
 }finally{release?.();stop();await closeNativeRenderer();await f.cleanup();}
});
