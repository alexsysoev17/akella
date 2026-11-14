import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectionArgumentSchemas,inspectionArgumentExamples,inspectionLimits} from '../src/motion/inspection-contracts.js';

test('Every advertised inspection argument example validates with the exact runtime schema',()=>{
  for(const name of Object.keys(inspectionArgumentExamples) as (keyof typeof inspectionArgumentExamples)[]){
    const example=inspectionArgumentExamples[name];
    assert.deepEqual(inspectionArgumentSchemas[name].parse(example),example);
    assert.throws(()=>inspectionArgumentSchemas[name].parse({...example,limit:8}),/limit/);
  }
  assert.equal(inspectionLimits.renderMaxFramesPerCall,8);
  assert.equal(inspectionArgumentSchemas.renderFrame.safeParse({frames:Array.from({length:8},(_,i)=>i),logicalObjectIds:['one']}).success,true);
  assert.equal(inspectionArgumentSchemas.renderFrame.safeParse({frames:Array.from({length:9},(_,i)=>i)}).success,false);
  assert.equal(inspectionArgumentSchemas.evaluateObjectAtTime.safeParse({sceneId:'s',targetId:'t',frames:Array.from({length:65},(_,i)=>i)}).success,true);
  assert.equal(inspectionArgumentSchemas.evaluateObjectAtTime.safeParse({sceneId:'s',targetId:'t',frames:Array.from({length:66},(_,i)=>i)}).success,false);
});
