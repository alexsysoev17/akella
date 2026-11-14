import test,{after} from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {identityFixture,node} from './identity-fixture.js';import {logicalId} from '../src/motion/registry.js';
import {NativeRenderer} from '../src/native/renderer.js';import {compositionFrameChecks,compositionQA} from '../src/native/composition-qa.js';import {closeNativeRenderer} from '../src/native/client.js';
after(()=>closeNativeRenderer());
test('reference scene chain: persistent instances retain pose/visibility/z-order across organizational cuts, sequential and random native rendering agree',async()=>{
 const f=await identityFixture(4,scenes=>{scenes.forEach((s,i)=>{s.width=320;s.height=180;s.properties={width:320,height:180,clipsContent:true,fills:[]};const bg=node('bg'+i,'Background',0,0,320,180);bg.properties.fills=[{type:'SOLID',color:{r:0,g:.5,b:0}}];const phone=node('phone'+i,'Phone',100+i*10,60,30,50),logo=node('logo'+i,'Logo',10,10+i*2,25,10);phone.properties.fills=[{type:'SOLID',color:{r:1,g:1,b:1}}];logo.properties.fills=[{type:'SOLID',color:{r:1,g:0,b:0}}];s.children=[bg,phone,logo];});});
 const state=f.state;state.settings={...state.settings,width:320,height:180,fps:30,durationFrames:300};state.blocks.forEach((b,i)=>{b.startFrame=i*60;b.durationFrames=i===3?120:60;});
 state.animations=[{animationId:'bg-in',sceneId:'s0',targetId:'bg0',effect:'fadeIn',startFrame:0,durationFrames:15,enabled:true,easing:'linear',parameters:{from:0,to:1}},{animationId:'logo-in',sceneId:'s0',targetId:'logo0',effect:'fadeIn',startFrame:30,durationFrames:15,enabled:true,easing:'linear',parameters:{from:0,to:1}},{animationId:'phone-in',sceneId:'s1',targetId:'phone1',effect:'fadeIn',startFrame:60,durationFrames:15,enabled:true,easing:'linear',parameters:{from:0,to:1}}];
 const transition=(name:string,from:number,to:number,start:number)=>({transitionId:name+from+to,logicalObjectId:logicalId(name),fromSceneId:'s'+from,toSceneId:'s'+to,startFrame:start,durationFrames:21,easing:'linear' as const,timelinePolicy:'referenceStates' as const,proceduralEffects:[],layerPolicy:{type:'switch' as const,switchProgress:1}});
 state.objectTransitions=[transition('Logo',0,1,60),transition('Logo',1,2,150),transition('Phone',1,2,150),transition('Phone',2,3,240)];
 const renderer=await NativeRenderer.create(f.project),hashes=new Map<number,string>();
 try{
  for(let frame=0;frame<300;frame++){
   const image=renderer.render(state,frame,{scale:.25,diagnostics:true});hashes.set(frame,createHash('sha256').update(image.png).digest('hex'));
   const c=image.composition!;assert.equal(c.activeScenes[0].sceneId,frame<81?'s0':frame<171?'s1':frame<261?'s2':'s3');
   if(frame>75)assert.equal(c.instances.filter(i=>i.logicalObjectId===logicalId('Phone')&&i.visible).length,1,'phone continuous at '+frame);
   if(frame>45)assert.equal(c.instances.filter(i=>i.logicalObjectId===logicalId('Logo')&&i.visible).length,1,'logo continuous at '+frame);
   assert.deepEqual(compositionFrameChecks(f.project,state,image).filter(c=>c.status==='FAILED'),[],'composition at '+frame);
  }
  assert.equal(hashes.get(119),hashes.get(120),"organizational marker cannot teleport the phone to a future reference");
  assert.equal(hashes.get(179),hashes.get(180),"organizational marker cannot cover persistent objects with another scene");
  for(const frame of [299,120,119,180,171,149,150,261,240,60,81,0])assert.equal(createHash('sha256').update(renderer.render(state,frame,{scale:.25}).png).digest('hex'),hashes.get(frame));
  const frame=renderer.render(state,195,{scale:.25,diagnostics:true});const broken=structuredClone(frame);for(const i of broken.composition!.instances)if(i.logicalObjectId===logicalId('Logo'))i.visible=false;assert.ok(compositionFrameChecks(f.project,state,broken).some(c=>c.name==='logicalObjectContinuity'&&c.status==='FAILED'));
  const duplicate=structuredClone(frame);duplicate.composition!.instances.push({...duplicate.composition!.instances.find(i=>i.logicalObjectId===logicalId('Phone')&&i.visible)!});assert.ok(compositionFrameChecks(f.project,state,duplicate).some(c=>c.name==='duplicateLogicalObject'&&c.status==='FAILED'));
  const report=await compositionQA(f.project,state,'motion/qa/composition');assert.equal(report.status,'PASSED');
 }finally{renderer.dispose();await f.cleanup();}
});

test('frame inspector API returns actual rendered instances and adjacent-state changes without a model call',async()=>{
 const f=await identityFixture(1);try{
  const {motionApi}=await import('../src/motion/api.js');
  let status=0,output='';const response={writeHead:(code:number)=>{status=code;},end:(data:string)=>{output=data;}};
  await motionApi(f.project,{method:'GET',url:'/api/projects/test/motion/inspect-frame?frame=1&compare=0'} as never,response as never,['api','projects','test','motion','inspect-frame'],async()=>Buffer.alloc(0));
  assert.equal(status,200);const result=JSON.parse(output);assert.ok(result.revision);assert.ok(result.composition.instances.length);assert.ok(Array.isArray(result.compare.changes));assert.equal(result.compare.frame,0);
 }finally{await closeNativeRenderer();await f.cleanup();}
});

test('Inspector frame tab works without saved AI runs and displays current native frame',async()=>{
 const f=await identityFixture(1);const {servePlatform}=await import('../src/platform-server.js');const {chromium}=await import('playwright');const server=await servePlatform((await import('node:path')).default.dirname(f.project.root),0);let browser;
 try{const address=server.address() as {port:number};browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.goto(`http://127.0.0.1:${address.port}/#project/${f.project.config.projectId}`);await page.getByRole('button',{name:'Inspector',exact:true}).click();await page.getByRole('tab',{name:'Кадр',exact:true}).click();await page.locator('[data-frame-form] input').fill('1');await page.getByRole('button',{name:'Показать и сравнить с предыдущим'}).click();await page.locator('.inspector-body img').waitFor();assert.match(await page.locator('.inspector-body').innerText(),/Вычисленная композиция/);assert.ok(await page.locator('.inspector-body img').evaluate((img:any)=>img.complete&&img.naturalWidth>0));
 }finally{await browser?.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await closeNativeRenderer();await f.cleanup();}
});
