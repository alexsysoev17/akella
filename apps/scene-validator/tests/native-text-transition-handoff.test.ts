import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {identityFixture,node} from './identity-fixture.js';
import {logicalId} from '../src/motion/registry.js';
import {applyOperations} from '../src/motion/operations.js';
import {renderNativeFrame,closeNativeRenderer} from '../src/native/client.js';
import {segmentAnimation} from '../src/motion/text-segment.js';
import {evaluateAnimation} from '../src/motion/evaluation.js';
import type {Animation,Operation} from '../src/motion/schema.js';
after(()=>closeNativeRenderer());

async function fixture(){
  const f=await identityFixture(3,scenes=>scenes.forEach((s,i)=>{
    const text=node(`text${i}`,'Headline',20+i*7,20+i*3,150,70);text.type='TEXT';
    text.text={characters:'Первый текст\nВторая строка',fontName:{family:'Arial',style:'Regular'},fontSize:18,lineHeight:{unit:'PIXELS',value:24},textAutoResize:'NONE'};
    text.properties.fills=[{type:'SOLID',color:{r:1,g:1,b:1}}];s.children=[text];
  }));
  const transition={...f.transition,logicalObjectId:logicalId('Headline')};
  return {...f,transition};
}
const reveal=(to=1):Animation=>({animationId:'reveal',sceneId:'s1',targetId:'text1',effect:'maskReveal',startFrame:12,durationFrames:3,easing:'linear',enabled:true,parameters:{from:0,to,direction:'forward'}});
const segmented=(segmentation:'line'|'word',to=0,durationFrames=5):Animation=>({animationId:'text-enter',sceneId:'s1',targetId:'text1',effect:'keyframes',startFrame:12,durationFrames,easing:'easeOutCubic',enabled:true,text:{segmentation,timing:'staggered',staggerFrames:1,reverse:false,origin:'local'},parameters:{property:'y',points:[{frame:0,value:12},{frame:durationFrames,value:to}]}});

test('Completed text reveals and staggered entries remain pixel-identical to unmodified text before and throughout a later transition',async()=>{
  const f=await fixture();try{
    const transition={type:'animateObjectStateTransition',...f.transition} as Operation;
    const baseline=applyOperations(f.state,[transition],f.project);
    for(const animation of [reveal(),segmented('line'),segmented('word')]){
      const state=applyOperations(f.state,[{type:'addAnimation',animation},transition],f.project);
      const opening=await renderNativeFrame(f.project,state,12,{scale:1,diagnostics:true}),plainOpening=await renderNativeFrame(f.project,baseline,12,{scale:1,diagnostics:true});
      assert.notDeepEqual(opening.png,plainOpening.png,`${animation.effect}/${animation.text?.segmentation}: the actual entrance must render`);
      const shaped=animation.text?opening.text.find(t=>t.targetId==='text1'):undefined;
      if(animation.text){assert.ok(shaped&&shaped.units>=2);for(let i=0;i<shaped.units;i++){const unit=segmentAnimation(animation,shaped.units,i);assert.ok(unit.startFrame+unit.durationFrames<=animation.startFrame+animation.durationFrames);assert.equal(evaluateAnimation(unit,17).y,0);}}
      for(const frame of [17,18,19,21,23,24]){
        const actual=await renderNativeFrame(f.project,state,frame,{scale:1,diagnostics:true}),expected=await renderNativeFrame(f.project,baseline,frame,{scale:1,diagnostics:true});
        assert.ok(Buffer.from(actual.png).equals(expected.png),`${animation.effect}/${animation.text?.segmentation}: neutral handoff at frame${frame}; actual text ${JSON.stringify(actual.text)}`);
        assert.equal(actual.composition!.instances.filter(i=>i.visible&&i.logicalObjectId===f.transition.logicalObjectId).length,1);
      }
    }
  }finally{await f.cleanup();}
});

test('Partial, hidden, unfinished and displaced text entrances still conflict with transition ownership',async()=>{
  const f=await fixture();try{
    for(const animation of [reveal(.5),reveal(0),{...reveal(),durationFrames:12},segmented('line',3),segmented('word',0,12)]){
      assert.throws(()=>applyOperations(f.state,[{type:'addAnimation',animation},{type:'animateObjectStateTransition',...f.transition}],f.project),/TRANSITION_COMPOSITION_CONFLICT/);
    }
  }finally{await f.cleanup();}
});
