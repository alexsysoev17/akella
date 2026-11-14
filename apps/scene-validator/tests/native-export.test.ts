import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile,chmod} from 'node:fs/promises';
import path from 'node:path';
import {identityFixture,node} from './identity-fixture.js';
import {readMotion,changeMotion} from '../src/motion/store.js';
import {numericQA} from '../src/motion/qa/numeric.js';
import {statePresentation} from '../src/motion/transitions.js';
import {exportVideo} from '../src/motion/video.js';
import {exportReports,exportReport} from '../src/motion/export-reports.js';
import {closeNativeRenderer} from '../src/native/client.js';
import {servePlatform} from '../src/platform-server.js';
import {chromium} from 'playwright';
after(()=>closeNativeRenderer());
async function fixture(){
 const f=await identityFixture(1,scenes=>{scenes[0].children=[node('logo','Logo',50,20,20,20)];});
 const d=await readMotion(f.project);
 const doc=(await changeMotion(f.project.root,{expectedRevision:d.revision,request:'saved subtle motion',operations:[
  {type:'setProjectSettings',settings:{...d.state.settings,width:200,height:120,fps:30,durationFrames:60}},
  {type:'setBlocks',blocks:d.state.blocks.map(b=>({...b,startFrame:0,durationFrames:60}))},
  {type:'addAnimation',animation:{animationId:'move',sceneId:'s0',targetId:'logo',effect:'moveTo',parameters:{fromX:0,fromY:10,toX:0,toY:0},startFrame:0,durationFrames:15,easing:'linear',enabled:true}},
  {type:'setExpression',expression:{expressionId:'subtle',sceneId:'s0',targetId:'logo',type:'inertialOvershoot',property:'y',sourceAnimationId:'move',startFrame:15,durationFrames:30,enabled:true,parameters:{mode:'ae',amplitude:.00001,frequency:2,decay:4,settlingEnvelope:'smoothTail',velocityLookbackFrames:1}}}
 ]})).document;return {...f,doc};
}
test('saved subpixel inertia warns during export, still fails intent visibility; Full/Half/Quarter MP4 decode unchanged motion',async()=>{
 const f=await fixture();try{
  const p=statePresentation(f.project,f.doc.state),intent=numericQA(f.doc.state,'',p),output=numericQA(f.doc.state,'',p,{purpose:'export'});
  assert.equal(intent.checks.find(c=>c.name==='visibleOscillation')?.status,'FAILED');assert.equal(output.checks.find(c=>c.name==='visibleOscillation')?.status,'WARNING');
  const before=await readFile(path.join(f.project.root,'motion/motion.json'));let checks;
  for(const quality of ['full','half','quarter'] as const){
   const v=await exportVideo(f.project.root,()=>{},{renderer:'native',...(quality==='full'?{}:{draftQuality:quality})});assert.ok('outputValidation'in v);if(!('outputValidation'in v))throw Error('native expected');
   assert.deepEqual(v.outputValidation,{width:quality==='full'?200:quality==='half'?100:50,height:quality==='full'?120:quality==='half'?60:30,fps:30,frames:60,durationSeconds:2,decodedAllFrames:true});
   assert.equal(v.qa.status,'WARNING');if(checks)assert.deepEqual(v.qa.numeric,checks);checks=v.qa.numeric;
   const report=await exportReport(f.project.root,v.exportJobId);assert.equal(report.status,'COMPLETED');assert.equal(report.projectRevision,f.doc.revision);assert.ok(report.outputFileSize>0);
  }
  assert.deepEqual(await readFile(path.join(f.project.root,'motion/motion.json')),before);assert.equal((await exportReports(f.project.root)).length,3);
 }finally{await f.cleanup();}
});
test('real discontinuity remains blocking and identifies frame/object, independent of raster resolution',async()=>{
 const f=await fixture();try{
  const doc=(await changeMotion(f.project.root,{expectedRevision:f.doc.revision,request:'intentional jump',operations:[{type:'addAnimation',animation:{animationId:'jump',sceneId:'s0',targetId:'logo',effect:'moveTo',parameters:{fromX:50,fromY:50,toX:0,toY:0},startFrame:45,durationFrames:10,easing:'linear',enabled:true}}]})).document;
  for(const draftQuality of ['full','quarter'] as const)await assert.rejects(exportVideo(f.project.root,()=>{},{renderer:'native',draftQuality}),{code:'EXPORT_QA_FAILED'});
  const reports=await exportReports(f.project.root);assert.equal(reports.length,2);for(const r of reports){assert.equal(r.stage,'motion-qa');assert.equal(r.failingInvariant,'trackJunction');assert.equal(r.failingFrame,45);assert.equal(r.failingObjectId,'logo');assert.equal(r.projectRevision,doc.revision);}
 }finally{await f.cleanup();}
});
test('encoder failures, invalid container, cancellation and timeout persist distinct diagnostics and release project lock',async()=>{
 const f=await fixture(),old=process.env.MOTION_FFMPEG_BIN;try{
  const before=await readFile(path.join(f.project.root,'motion/motion.json'));
  process.env.MOTION_FFMPEG_BIN=path.join(f.root,'missing-encoder');await assert.rejects(exportVideo(f.project.root,()=>{},{renderer:'native',draftQuality:'quarter'}),{code:'EXPORT_ENCODER_FAILED'});
  const fake=path.join(f.root,'fake-encoder');await writeFile(fake,'#!'+process.execPath+'\nconst fs=require("fs");if(process.argv.includes("-c:v")){process.stdin.resume();process.stdin.on("end",()=>fs.writeFileSync(process.argv.at(-1),"invalid mp4"));}else{process.exitCode=1;}');await chmod(fake,0o755);process.env.MOTION_FFMPEG_BIN=fake;
  await assert.rejects(exportVideo(f.project.root,()=>{},{renderer:'native',draftQuality:'quarter'}),{code:'EXPORT_OUTPUT_INVALID'});
  if(old===undefined)delete process.env.MOTION_FFMPEG_BIN;else process.env.MOTION_FFMPEG_BIN=old;
  const controller=new AbortController();await assert.rejects(exportVideo(f.project.root,()=>controller.abort(),{renderer:'native',draftQuality:'quarter',signal:controller.signal}),{code:'EXPORT_CANCELLED'});
  await assert.rejects(exportVideo(f.project.root,()=>{},{renderer:'native',timeoutMs:0}),{code:'EXPORT_TIMEOUT'});
  const reports=await exportReports(f.project.root);assert.deepEqual(reports.map(r=>r.errorCode).sort(),['EXPORT_CANCELLED','EXPORT_ENCODER_FAILED','EXPORT_OUTPUT_INVALID','EXPORT_TIMEOUT'].sort());
  assert.deepEqual(await readFile(path.join(f.project.root,'motion/motion.json')),before);assert.deepEqual(await readdir(path.join(f.project.root,'renders')),[]);
  await exportVideo(f.project.root,()=>{},{renderer:'native',draftQuality:'quarter'});
 }finally{if(old===undefined)delete process.env.MOTION_FFMPEG_BIN;else process.env.MOTION_FFMPEG_BIN=old;await f.cleanup();}
});
test('persistent export diagnostics are available through API and Inspector without an Agent run',async()=>{
 const f=await fixture();let server;try{
  const controller=new AbortController();controller.abort();await assert.rejects(exportVideo(f.project.root,()=>{},{signal:controller.signal}),{code:'EXPORT_CANCELLED'});
  server=await servePlatform(path.dirname(f.project.root),0);const address=server.address();assert.ok(address&&typeof address!=='string');const origin='http://127.0.0.1:'+address.port,base=origin+'/api/projects/'+f.project.config.projectId+'/motion';
  const reports=await(await fetch(base+'/export-reports')).json();assert.equal(reports.length,1);
  const resumed=await(await fetch(base+'/jobs/'+reports[0].exportJobId)).json();assert.equal(resumed.status,'failed');assert.equal(resumed.exportDiagnostics.errorCode,'EXPORT_CANCELLED');
  const browser=await chromium.launch();try{const page=await browser.newPage();page.setDefaultTimeout(5000);await page.goto(origin+'/#project/'+f.project.config.projectId);await page.locator('#m-inspector').click();await page.locator('[data-tab="6"]').click();await page.locator('.inspector-body section details > summary').first().click({position:{x:8,y:8}});await page.getByText('EXPORT_CANCELLED',{exact:true}).first().waitFor();}finally{await browser.close();}
 }finally{if(server)await new Promise<void>(r=>server!.close(()=>r()));await f.cleanup();}
});
