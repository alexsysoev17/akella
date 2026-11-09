import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chromium,webkit} from 'playwright';
import {identityFixture,node} from './identity-fixture.js';
import {previewScales,renderDimensions} from '../src/native/quality.js';
import {renderNativeFrame,closeNativeRenderer,clearNativeCache} from '../src/native/client.js';
import {NativeRenderer} from '../src/native/renderer.js';
import {nativeMemory} from '../src/native/skia.js';
import {readMotion,changeMotion} from '../src/motion/store.js';
import {logicalId} from '../src/motion/registry.js';
import {evaluateMotion} from '../src/motion/evaluation.js';
import {statePresentation} from '../src/motion/transitions.js';
import {servePlatform} from '../src/platform-server.js';
import {exportVideo} from '../src/motion/video.js';
import {nativePreviewHtml} from '../src/native/preview.js';
after(()=>closeNativeRenderer());
async function fixture(w=1920,h=1080){
 const f=await identityFixture(2,scenes=>scenes.forEach((s,j)=>{
  const circle=node('circle'+j,'Circle',40+j*100,40,80,80);circle.type='ELLIPSE';circle.properties={...circle.properties,fills:[{type:'SOLID',color:{r:1,g:1,b:1}}],effects:[{type:'DROP_SHADOW',radius:2,offset:{x:2,y:3},color:{r:0,g:0,b:0,a:.5}}]};
  const text=node('text'+j,'Text',250,100,300,90);text.type='TEXT';text.text={characters:'Native Preview\nSame logical layout',fontName:{family:'Arial',style:'Regular'},fontSize:25,lineHeight:{unit:'PIXELS',value:32}};text.properties.fills=[{type:'SOLID',color:{r:1,g:1,b:1}}];
  const vector=node('line'+j,'Line',250,300,300,100);vector.type='VECTOR';vector.properties={...vector.properties,fills:[],strokes:[{type:'SOLID',color:{r:1,g:1,b:1}}],strokeWeight:5,strokeCap:'ROUND',strokeJoin:'ROUND',vectorPaths:[{data:'M0 0 C100 80 200 -40 300 70',windingRule:'NONZERO'}]};
  const gradient=node('gradient'+j,'Gradient',800,80,200,100);gradient.properties.fills=[{type:'GRADIENT_LINEAR',gradientTransform:[[1,0,0],[0,1,0]],gradientStops:[{position:0,color:{r:1,g:0,b:0,a:1}},{position:1,color:{r:0,g:0,b:1,a:1}}]}];
  const mask=node('mask'+j,'Mask',1200,80,100,100);mask.type='ELLIPSE';mask.properties.isMask=true;mask.properties.maskType='VECTOR';
  const masked=node('masked'+j,'Masked',1180,50,180,180);masked.properties.fills=[{type:'SOLID',color:{r:0,g:1,b:0}}];
  s.children=[circle,text,vector,gradient,mask,masked];s.width=w;s.height=h;s.properties={width:w,height:h,clipsContent:true,fills:[{type:'SOLID',color:{r:.1,g:.1,b:.1}}]};
 }));
 const doc=await readMotion(f.project);
 const saved=(await changeMotion(f.project.root,{expectedRevision:doc.revision,request:'preview quality fixture',operations:[{type:'setProjectSettings',settings:{...f.state.settings,width:w,height:h,fps:30,durationFrames:60}},{type:'setBlocks',blocks:f.state.blocks.map((b,i)=>({...b,startFrame:i*30,durationFrames:30}))},{type:'animateObjectStateTransition',transitionId:'move',logicalObjectId:logicalId('Circle'),fromSceneId:'s0',toSceneId:'s1',startFrame:15,durationFrames:15,easing:'easeInOutCubic',proceduralEffects:[],layerPolicy:{type:'switch',switchProgress:.5},timelinePolicy:'referenceStates'},{type:'addAnimation',animation:{animationId:'trim',sceneId:'s1',targetId:'line1',startFrame:30,durationFrames:20,effect:'trimPath',parameters:{from:0,to:1,direction:'forward'},easing:'linear',enabled:true}},{type:'setExpression',expression:{expressionId:'wiggle',type:'wiggle',sceneId:'s0',targetId:'circle0',property:'rotation',startFrame:0,durationFrames:60,enabled:true,ownership:{scope:'logicalObject',logicalObjectId:logicalId('Circle')},parameters:{temporalMode:'continuous',amplitude:3,frequency:.8,seed:42}}},{type:'setExpression',expression:{expressionId:'inertia',type:'inertialOvershoot',sceneId:'s0',targetId:'circle0',property:'x',sourceAnimationId:'move',transitionId:'move',startFrame:30,durationFrames:20,enabled:true,parameters:{mode:'ae',settlingEnvelope:'smoothTail',amplitude:.25,frequency:2.5,decay:3,velocityLookbackFrames:3}}}]})).document;
 return {...f,doc:saved};
}
test('Full/Half/Third/Quarter are real native surface sizes; world transforms, text, transitions, effects and project bytes are unchanged',async()=>{
 const f=await fixture();try{
  const before=await readFile(path.join(f.project.root,'motion/motion.json'));
  const logical=evaluateMotion(f.doc.state,34,statePresentation(f.project,f.doc.state));
  const frames=[];
  for(const [quality,scale] of Object.entries(previewScales)){
   const frame=await renderNativeFrame(f.project,f.doc.state,34,{scale,encoding:'rgba',cache:false});frames.push(frame);
   const size=renderDimensions(1920,1080,scale);assert.equal(frame.width,size.width,quality);assert.equal(frame.height,size.height);assert.equal(frame.png.byteLength,size.width*size.height*4);
   assert.deepEqual(frame.hits,frames[0].hits);assert.deepEqual(frame.paths,frames[0].paths);assert.deepEqual(evaluateMotion(f.doc.state,34,statePresentation(f.project,f.doc.state)),logical);
  }
  for(const f of frames){const scale=f.width/1920;const at=(x:number,y:number)=>[...f.png.slice((Math.floor(y*scale)*f.width+Math.floor(x*scale))*4,(Math.floor(y*scale)*f.width+Math.floor(x*scale))*4+4)];assert.deepEqual(at(1250,130),[0,255,0,255]);assert.deepEqual(at(1190,130),[26,26,26,255]);}
  assert.deepEqual(frames.map(f=>[f.width,f.height]),[[1920,1080],[960,540],[640,360],[480,270]]);
  const repeated=await renderNativeFrame(f.project,f.doc.state,34,{scale:1/3,encoding:'rgba',cache:false});assert.deepEqual(repeated.png,frames[2].png);
  assert.deepEqual(await readFile(path.join(f.project.root,'motion/motion.json')),before);assert.equal((await readMotion(f.project)).state.settings.width,1920);
  const probeRenderer=await NativeRenderer.create(f.project);try{assert.throws(()=>probeRenderer.render(f.doc.state,34,{scale:.25,encoding:'rgba',coverageProbe:{focus:[],ignore:[]}}),/COVERAGE_ENCODING_REQUIRED/);}finally{probeRenderer.dispose();}
  assert.deepEqual(renderDimensions(1919,1079,1/3),{width:640,height:360});assert.deepEqual(renderDimensions(1,1,.25),{width:1,height:1});
 }finally{await f.cleanup();}
});
test('quality/revision cache keys stay distinct and queued preview work is coalesced without changing the newest frame',async()=>{
 const f=await fixture();try{
  await clearNativeCache();
  const a=await renderNativeFrame(f.project,f.doc.state,2,{scale:.25,encoding:'rgba',cacheNamespace:'preview/r1'});assert.equal(a.cacheHit,false);
  const full=await renderNativeFrame(f.project,f.doc.state,2,{scale:1,encoding:'rgba',cacheNamespace:'preview/r1'});assert.equal(full.cacheHit,false);
  const cached=await renderNativeFrame(f.project,f.doc.state,2,{scale:.25,encoding:'rgba',cacheNamespace:'preview/r1'});assert.equal(cached.cacheHit,true);assert.deepEqual(cached.png,a.png);assert.equal(cached.resourceReuse?.renderer,true);
  const newRevision=await renderNativeFrame(f.project,f.doc.state,2,{scale:.25,encoding:'rgba',cacheNamespace:'preview/r2'});assert.equal(newRevision.cacheHit,false);
  const requests=await Promise.allSettled(Array.from({length:20},(_,i)=>renderNativeFrame(f.project,f.doc.state,i,{scale:.25,encoding:'rgba',previewSession:'quality-test',previewRequest:i+1})));
  assert.equal(requests.at(-1)!.status,'fulfilled');assert.ok(requests.some(r=>r.status==='rejected'&&/supersed/i.test(String(r.reason))));
  const result=requests.at(-1)!;assert.equal(result.status==='fulfilled'&&result.value.frame,19);
 }finally{await f.cleanup();}
});
test('repeated resolution changes release all Skia surfaces and reuse immutable resources',async()=>{
 const f=await fixture();const r=await NativeRenderer.create(f.project);try{
  const created=nativeMemory(r.kit).created;
  for(let i=0;i<40;i++){const q=Object.values(previewScales)[i%4];const out=r.render(f.doc.state,i%60,{scale:q,encoding:'rgba'});assert.equal(out.png.byteLength,out.width*out.height*4);assert.equal(nativeMemory(r.kit).live,0);}
  const memory=nativeMemory(r.kit);assert.equal(memory.created-memory.disposed,0);assert.ok(memory.created-created>=40);
 }finally{r.dispose();await f.cleanup();}
});
test('draft resolutions encode actual dimensions at unchanged FPS/duration; Final ignores viewport quality and uses Full QA',async()=>{
 const f=await fixture(321,181);try{
  let doc=await readMotion(f.project);
  doc=(await changeMotion(f.project.root,{expectedRevision:doc.revision,request:'short video',operations:[{type:'removeAnimation',animationId:'trim'},{type:'removeExpression',expressionId:'inertia'},{type:'removeExpression',expressionId:'wiggle'},{type:'removeObjectStateTransition',transitionId:'move'},{type:'setProjectSettings',settings:{...doc.state.settings,fps:24,durationFrames:12}},{type:'setBlocks',blocks:doc.state.blocks.map((b,i)=>({...b,startFrame:i*6,durationFrames:6}))}]})).document;
  const before=await readFile(path.join(f.project.root,'motion/motion.json'));
  const ffmpeg=createRequire(import.meta.url)('ffmpeg-static') as string;
  for(const quality of Object.keys(previewScales) as (keyof typeof previewScales)[]){
   const video=await exportVideo(f.project.root,()=>{},{renderer:'native',draftQuality:quality});assert.ok('renderResolution' in video);
   if(!('renderResolution' in video))throw Error('native expected');
   const size=renderDimensions(321,181,previewScales[quality]);assert.deepEqual(video.renderResolution,size);assert.equal(video.fps,24);assert.equal(video.frames,12);assert.equal(video.qa.level,'DRAFT_TECHNICAL');assert.equal(video.qa.renderScale,previewScales[quality]);
   const decoded=await promisify(execFile)(ffmpeg,['-hide_banner','-i',path.join(f.project.root,'renders',video.file),'-f','rawvideo','-pix_fmt','rgba','pipe:1'],{encoding:'buffer',maxBuffer:10*1024*1024});assert.equal(decoded.stdout.byteLength,video.encodedSize.width*video.encodedSize.height*4*12);assert.match(decoded.stderr.toString(),/24 fps/);assert.match(decoded.stderr.toString(),/Duration: 00:00:00\.50/);assert.ok(decoded.stderr.toString().includes(video.encodedSize.width+'x'+video.encodedSize.height));
  }
  await renderNativeFrame(f.project,doc.state,0,{scale:.25});
  const final=await exportVideo(f.project.root,()=>{},{renderer:'native'});assert.ok('renderResolution' in final);if(!('renderResolution' in final))throw Error('native expected');assert.deepEqual(final.renderResolution,{width:321,height:181});assert.equal(final.qa.level,'FULL_TECHNICAL');assert.equal(final.qa.renderScale,1);assert.deepEqual(final.encodedSize,{width:322,height:182});
  assert.deepEqual(await readFile(path.join(f.project.root,'motion/motion.json')),before);
 }finally{await f.cleanup();}
});
test('viewport quality, Auto, hit testing, seeking/playback and persistent preference work in Chromium/WebKit without Agent calls',async()=>{
 const f=await fixture(),server=await servePlatform(path.dirname(f.project.root),0),address=server.address();assert.ok(address&&typeof address!=='string');const origin='http://127.0.0.1:'+address.port;
 const originalMotion=await readFile(path.join(f.project.root,'motion/motion.json'));
 try{
  for(const launcher of [chromium,webkit]){
   const browser=await launcher.launch();try{
    const page=await browser.newPage({viewport:{width:1200,height:850}});let agentCalls=0;page.on('request',r=>{if(/\/motion\/(execute|plan)$/.test(r.url()))agentCalls++;});
    await page.goto(origin+'/#project/'+f.project.config.projectId);const preview=page.frameLocator('#m-preview');await preview.locator('body[data-native-renderer="skia-cpu/1"]').waitFor();
    const iframe=page.frames().find(f=>f.url().includes('/motion/preview'))!;
    await page.evaluate(()=>{addEventListener('message',e=>{if(e.data?.type==='motion-select')(window as any).__picked=e.data;});});
    for(const [quality,scale] of Object.entries(previewScales)){
     await page.locator('#m-preview-quality').selectOption(quality);await preview.locator('body[data-rendered-frame="0"][data-preview-scale="'+scale+'"]').waitFor();
     const size=renderDimensions(1920,1080,scale);assert.equal(await preview.locator('body').getAttribute('data-source-size'),size.width+'x'+size.height);
     const box=await page.locator('#m-preview').boundingBox();assert.ok(box);const ratio=Math.min(box.width/1920,box.height/1080);
     await page.evaluate(()=>{(window as any).__picked=null;});await page.mouse.click(box.x+(box.width-1920*ratio)/2+80*ratio,box.y+(box.height-1080*ratio)/2+80*ratio);
     await page.waitForFunction(()=>(window as any).__picked?.targetId==='circle0');
    }
    await page.locator('#m-preview-quality').selectOption('quarter');await iframe.evaluate(()=>{window.motionFrame(1);window.motionFrame(4);window.motionFrame(2);});await preview.locator('body[data-rendered-frame="2"][data-preview-scale="0.25"]').waitFor();
    await iframe.evaluate(()=>window.motionFrame(20,{playing:true}));await preview.locator('body[data-rendered-frame="20"]').waitFor();await iframe.evaluate(()=>window.motionFrame(0,{playing:true}));await preview.locator('body[data-rendered-frame="0"]').waitFor();
    await page.locator('#m-preview-quality').selectOption('auto');await iframe.evaluate(()=>window.motionFrame(3));await preview.locator('body[data-rendered-frame="3"][data-preview-scale="1"]').waitFor({timeout:5000}).catch(async error=>{console.log(await iframe.evaluate(()=>({dataset:{...document.body.dataset},metrics:window.nativePreviewMetrics,error:document.querySelector('#error')?.textContent})));throw error;});
    const metrics=await iframe.evaluate(()=>window.nativePreviewMetrics);assert.equal(metrics?.projectResolution,'1920×1080');assert.equal(metrics?.quality,'auto');assert.ok(Number(metrics?.timeToFirstPreviewMs)>=0);
    await page.locator('#m-preview-quality').selectOption('quarter');await page.reload();await preview.locator('body[data-preview-scale="0.25"]').waitFor();assert.equal(await page.locator('#m-preview-quality').inputValue(),'quarter');assert.equal(agentCalls,0);
    assert.equal((await readMotion(f.project)).state.settings.width,1920);
   }finally{await browser.close();}
  }
  assert.deepEqual(await readFile(path.join(f.project.root,'motion/motion.json')),originalMotion);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await f.cleanup();}
});
test('delayed old frames/revisions cannot overwrite a newer sought frame; progressive first pixels and bounded cache are observable (mock transport)',async()=>{
 const browser=await chromium.launch();try{
  const page=await browser.newPage({viewport:{width:400,height:240}});const requests:{frame:number;scale:number}[]=[];
  await page.route('http://preview.test/frame?**',async route=>{
   const q=new URL(route.request().url()).searchParams,frame=Number(q.get('frame')),scale=Number(q.get('scale')),revision=q.get('revision');requests.push({frame,scale});
   if(frame===1)await new Promise(r=>setTimeout(r,150));
   const width=Math.max(1,Math.round(200*scale)),height=Math.max(1,Math.round(120*scale)),metadata=Buffer.from(JSON.stringify({width,height,frame,revision,renderer:'skia-cpu/1',warnings:[],hits:[],cacheHit:false,stats:{milliseconds:5},memory:{rss:100000}})),head=Buffer.alloc(4);head.writeUInt32BE(metadata.length);
   await route.fulfill({contentType:'application/x-akella-frame',body:Buffer.concat([head,metadata,Buffer.alloc(width*height*4,frame)])}).catch(()=>{});
  });
  await page.route('http://preview.test/',route=>route.fulfill({contentType:'text/html',body:nativePreviewHtml('http://preview.test',200,120,'r1',{quality:'auto',fps:30,durationFrames:60})}));
  await page.goto('http://preview.test/');await page.waitForSelector('body[data-rendered-frame="0"][data-preview-scale="0.25"]');assert.equal(requests[0].scale,.25);
  await page.evaluate(()=>window.motionPreviewQuality?.('quarter'));
  await page.evaluate(()=>window.motionFrame(1));await page.waitForTimeout(10);await page.evaluate(()=>{window.postMessage({type:'motion-state',revision:'r2'},location.origin);window.motionFrame(2);});
  await page.waitForSelector('body[data-rendered-frame="2"]');await page.waitForTimeout(220);
  assert.equal(await page.locator('body').getAttribute('data-rendered-frame'),'2');const metrics=await page.evaluate(()=>window.nativePreviewMetrics);assert.equal(metrics?.projectRevision,'r2');assert.ok(Number(metrics?.cancelledStaleJobs)>0);assert.ok(Number(metrics?.clientCacheBytes)<=16*1024*1024);
 }finally{await browser.close();}
});
test('Auto uses measured raster cost and hysteresis; oversized idle surfaces are capped before allocation (mock transport)',async()=>{
 const browser=await chromium.launch();try{
  const page=await browser.newPage();let rasterMs=100;
  await page.route('http://auto.test/frame?**',route=>{
   const q=new URL(route.request().url()).searchParams,s=Number(q.get('scale')),width=Math.round(200*s),height=Math.round(120*s),metadata=Buffer.from(JSON.stringify({width,height,frame:Number(q.get('frame')),revision:'r',renderer:'skia-cpu/1',warnings:[],hits:[],cacheHit:false,stats:{milliseconds:rasterMs}})),head=Buffer.alloc(4);head.writeUInt32BE(metadata.length);
   return route.fulfill({contentType:'application/x-akella-frame',body:Buffer.concat([head,metadata,Buffer.alloc(width*height*4)])});
  });
  await page.route('http://auto.test/',route=>route.fulfill({contentType:'text/html',body:nativePreviewHtml('http://auto.test',200,120,'r',{quality:'auto',fps:30,durationFrames:100})}));
  await page.goto('http://auto.test/');await page.waitForSelector('body[data-rendered-frame="0"]');
  for(let frame=1;frame<=7;frame++){await page.evaluate(f=>window.motionFrame(f,{playing:true}),frame);await page.waitForSelector('body[data-rendered-frame="'+frame+'"]');}
  assert.equal(await page.locator('body').getAttribute('data-preview-scale'),'0.25');
  rasterMs=1;
  for(let frame=8;frame<=15;frame++){await page.evaluate(f=>window.motionFrame(f,{playing:true}),frame);await page.waitForSelector('body[data-rendered-frame="'+frame+'"]');}
  assert.equal(await page.locator('body').getAttribute('data-preview-scale'),'0.25');assert.equal((await page.evaluate(()=>window.nativePreviewMetrics))?.fps,30);
  await page.route('http://limit.test/frame?**',route=>route.abort());await page.route('http://limit.test/',route=>route.fulfill({contentType:'text/html',body:nativePreviewHtml('http://limit.test',8000,8000,'r',{quality:'auto'})}));await page.goto('http://limit.test/');
  assert.equal(await page.evaluate(()=>(window as any).targetScale()),.5);
 }finally{await browser.close();}
});
test('HTTP Draft/Final pipeline serves downloadable videos and ignores viewport quality for final export',async()=>{
 const f=await fixture(320,180);let doc=await readMotion(f.project);doc=(await changeMotion(f.project.root,{expectedRevision:doc.revision,request:'short HTTP',operations:[{type:'removeAnimation',animationId:'trim'},{type:'removeExpression',expressionId:'inertia'},{type:'removeExpression',expressionId:'wiggle'},{type:'removeObjectStateTransition',transitionId:'move'},{type:'setProjectSettings',settings:{...doc.state.settings,durationFrames:6}},{type:'setBlocks',blocks:doc.state.blocks.map((b,i)=>({...b,startFrame:i*3,durationFrames:3}))}]})).document;
 const server=await servePlatform(path.dirname(f.project.root),0),address=server.address();assert.ok(address&&typeof address!=='string');const base='http://127.0.0.1:'+address.port+'/api/projects/'+f.project.config.projectId+'/motion';
 try{
  await fetch(base+'/frame?frame=0&scale=0.25');
  for(const mode of ['draft','final']){
   const response=await fetch(base+'/render',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode,quality:'quarter'})});assert.equal(response.status,202);const job=await response.json();let result;
   for(let i=0;i<100;i++){result=await(await fetch(base+'/jobs/'+job.jobId)).json();if(result.status!=='running')break;await new Promise(r=>setTimeout(r,20));}
   assert.equal(result.status,'completed',JSON.stringify(result));assert.deepEqual(result.result.renderResolution,mode==='draft'?{width:80,height:45}:{width:320,height:180});
   const files=await(await fetch(base+'/renders')).json();assert.ok(files.files.includes(result.result.file));
   const download:Response=await fetch(base+'/renders/'+result.result.file,{headers:{range:'bytes=0-7'}});assert.equal(download.status,206);assert.equal((await download.arrayBuffer()).byteLength,8);
  }
  assert.equal((await readMotion(f.project)).state.settings.width,320);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await f.cleanup();}
});
