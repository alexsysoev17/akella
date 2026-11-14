import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {identityFixture,node} from './identity-fixture.js';
import {logicalId} from '../src/motion/registry.js';
import {prepareNativeTextPose,renderNativeFrame,closeNativeRenderer} from '../src/native/client.js';
import {statePresentation} from '../src/motion/transitions.js';
import {interpolateState,normalizationSize} from '../src/motion/transition-runtime.js';
import {multiply} from '../src/motion/geometry.js';
import {applyOperations} from '../src/motion/operations.js';
import {compileAnchorChange} from '../src/motion/anchor-edit.js';
import {readMotion} from '../src/motion/store.js';
after(()=>closeNativeRenderer());

async function fixture(change?:'wrap'|'font'|'paint'){
  return identityFixture(3,scenes=>scenes.forEach((scene,i)=>{
    const t=node(`t${i}`,'Title',12,12,i===1?150:180,70);t.type='TEXT';
    t.text={characters:'Same glyphs\nSecond line',fontName:{family:'Arial',style:'Regular'},fontSize:18,lineHeight:{unit:'PIXELS',value:23},textAutoResize:'NONE'};
    t.properties.fills=[{type:'SOLID',color:{r:1,g:1,b:1}}];
    if(i===2&&change==='wrap')t.properties.width=70;
    if(i===2&&change==='font')(t.text as any).fontName={family:'Arial',style:'Bold'};
    if(i===2&&change==='paint')t.properties.fills=[{type:'SOLID',color:{r:1,g:0,b:0}}];
    scene.children=[t];
  }));
}
test('Empty text container width changes have one proven native pose across the instance switch',async()=>{
  const f=await fixture();try{
    const source=JSON.stringify(f.project.inspection.document);await readMotion(f.project);
    const proof=f.project.nativeTextPose!,id=logicalId('Title');assert.equal(proof.sourceFingerprint,f.project.inspection.fingerprint);assert.match(proof.fontFilesDigest!,/^[a-f0-9]{64}$/);assert.equal(proof.groups[id].refs.length,3);
    const state=applyOperations(f.state,[{type:'animateObjectStateTransition',...f.transition,timelinePolicy:'referenceStates',logicalObjectId:id,layerPolicy:{type:'switch',switchProgress:.5}}],f.project),p=statePresentation(f.project,state);
    assert.equal(p[id].s1.width,150);assert.equal(p[id].s1.normalizationWidth,180);assert.equal(p[id].s1.textPoseBasis,'native-equivalent-ink');
    let first:Uint8Array|undefined;
    for(const frame of [17,18,20,21,22,24,25]){
      const r=await renderNativeFrame(f.project,state,frame,{scale:1,diagnostics:true});
      if(first)assert.ok(Buffer.from(r.png).equals(first),`pixels frame${frame}; ${JSON.stringify(r.composition!.instances.filter(v=>v.visible&&v.logicalObjectId===id))}`);else first=r.png;
      const instance=r.composition!.instances.find(v=>v.visible&&v.logicalObjectId===id)!;assert.deepEqual(instance.transform,[[1,0,12],[0,1,12]]);
      if(frame>=18){const t=state.objectTransitions![0],pose=interpolateState(p[id].s1,p[id].s2,t,frame,state),n=normalizationSize(p[id].s1),sample=multiply(pose.matrix,[[1/n.width,0,0],[0,1/n.height,0]]);assert.deepEqual(sample,instance.transform);}
    }
    assert.equal(JSON.stringify(f.project.inspection.document),source);
  }finally{await f.cleanup();}
});
test('An actual wrap, font-face or paint change prevents normalization of the entire logical object',async()=>{
  for(const change of ['wrap','font','paint'] as const){const f=await fixture(change);try{
    await prepareNativeTextPose(f.project);const id=logicalId('Title');assert.equal(f.project.nativeTextPose!.groups[id],undefined);assert.match(f.project.nativeTextPose!.diagnostics[0].reason,/TEXT_POSE_LEGACY/);
    const p=statePresentation(f.project,f.state);assert.equal(p[id].s1.normalizationWidth,undefined);assert.equal(p[id].s1.textPoseBasis,'source-box-unverified');
  }finally{await f.cleanup();}}
});
test('Explicit source-box anchors keep their local coordinates and preserve visible pose with the derived basis',async()=>{
  const f=await fixture();try{
    await prepareNativeTextPose(f.project);const id=logicalId('Title');let state=applyOperations(f.state,[{type:'animateObjectStateTransition',...f.transition,timelinePolicy:'referenceStates',logicalObjectId:id,layerPolicy:{type:'switch',switchProgress:.5}}],f.project);
    state=applyOperations(state,[{type:'setAnchor',anchor:{logicalObjectId:id,point:{units:'normalized',x:.5,y:.5},preservation:'none',transform:{rotation:17}}}],f.project);
    const before=await renderNativeFrame(f.project,state,20,{diagnostics:true});
    const ops=compileAnchorChange(f.project,state,{action:'MOVE_ANCHOR',logicalObjectId:id,sceneId:'s1',frame:20,scope:'object',point:{units:'pixels',x:11,y:-7},preserveVisualPosition:true});
    const after=await renderNativeFrame(f.project,applyOperations(state,ops,f.project),20,{diagnostics:true});
    const a=before.composition!.instances.find(v=>v.visible&&v.logicalObjectId===id)!,b=after.composition!.instances.find(v=>v.visible&&v.logicalObjectId===id)!;
    for(let i=0;i<2;i++)for(let j=0;j<3;j++)assert.ok(Math.abs(a.transform![i][j]-b.transform![i][j])<1e-6);
  }finally{await f.cleanup();}
});
