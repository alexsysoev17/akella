import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {exactSchemaCatalog,expandSchemaCatalog,projectAgentContext} from '../src/motion/context-projection.js';
import {animationSchema} from '../src/motion/schema.js';
import {compactProviderFeedback} from '../src/motion/agent-runtime.js';
import {segmentAnimation} from '../src/motion/text-segment.js';
import {motionCapabilityContext} from '../src/motion/capability-context.js';
import {identityFixture} from './identity-fixture.js';

test('Interned real animation schemas expand byte-for-byte with all required fields, refs, enums and constraints',()=>{
  const schemas:[string,unknown][]=animationSchema.options.map(s=>[s.shape.effect.value,z.toJSONSchema(s)]);
  schemas.push(['nested-original-ref',{type:'object',$defs:{example:schemas[0][1]},properties:{a:{$ref:'#/$defs/example'},b:schemas[0][1]},required:['a','b'],additionalProperties:false}]);
  const packed=exactSchemaCatalog(schemas);
  assert.equal(JSON.stringify(expandSchemaCatalog(packed)),JSON.stringify(schemas));
  assert.ok(JSON.stringify(packed).length<JSON.stringify(schemas).length*.6);
  assert.match(packed.instruction,/Never send \$schemaFragment/);
  const broken=structuredClone(packed);broken.schemas=[['x',{$schemaFragment:'missing'}]];assert.throws(()=>expandSchemaCatalog(broken),/INVALID_SCHEMA_FRAGMENT/);
});
test('Changing working state leaves the exact request and schema dictionary as a stable cache prefix',()=>{
  const schemas:[string,unknown][]=animationSchema.options.slice(0,4).map(s=>[s.shape.effect.value,z.toJSONSchema(s)]),catalog=exactSchemaCatalog(schemas);
  const a=projectAgentContext('Original source brief',catalog,{context:{frame:0},taskHistory:[{result:'before'}]});
  const b=projectAgentContext('Original source brief',catalog,{context:{frame:44},taskHistory:[{result:'after'}]});
  let prefix=0;while(a[prefix]===b[prefix]&&prefix<a.length)prefix++;
  assert.ok(prefix>JSON.stringify(catalog).length);assert.deepEqual(JSON.parse(a).toolSchemaCatalog,JSON.parse(b).toolSchemaCatalog);
  assert.equal(JSON.parse(b).userRequest,'Original source brief');assert.equal(JSON.parse(b).context.frame,44);
});
test('Only obsolete render/sample geometry is archived; current evidence and original audit objects remain exact',()=>{
  const result=[{frame:12,artifact:'frame12.png',pixelHash:'pixels',width:480,height:270,observedInstances:[{targetId:'plate',worldMatrix:[[1,0,20],[0,1,40]],visible:true}]}];
  const before={results:[{call:{callId:'old',tool:'renderFrame',argumentsJson:'{"frames":[12]}'},observedDigest:'old',result}]};
  const after={results:[{call:{callId:'new',tool:'renderFrame',argumentsJson:'{"frames":[12]}'},observedDigest:'current',result}]};
  const original=structuredClone([before,after]);const projected=compactProviderFeedback([before,after],'current') as any[];
  assert.equal(projected[0].results[0].result.status,'STALE_OBSERVATION');assert.deepEqual(projected[0].results[0].result.artifacts,[{frame:12,artifact:'frame12.png',pixelHash:'pixels',width:480,height:270}]);
  assert.deepEqual(projected[1].results[0].result,result);assert.deepEqual([before,after],original);
  const qa=compactProviderFeedback([{results:[{call:{tool:'runFocusedQA',argumentsJson:'{}'},observedDigest:'old',result:{status:'FAILED',summary:'Text overlap',checks:[{checkId:'handoff',status:'FAILED',message:'Incoming before outgoing clears',largeFrameData:[1,2,3]}]}}]}],'current') as any[];
  assert.equal(qa[0].results[0].result.previousStatus,'FAILED');assert.deepEqual(qa[0].results[0].result.failedChecks,[{checkId:'handoff',status:'FAILED',message:'Incoming before outgoing clears'}]);
});
test('Text stagger failure identifies the exact track, native unit count and valid minimum total duration',()=>{
  const animation=animationSchema.parse({animationId:'benefit',sceneId:'scene',targetId:'text',effect:'fadeIn',startFrame:0,durationFrames:12,easing:'linear',enabled:true,parameters:{from:0,to:1},text:{segmentation:'word',timing:'staggered',staggerFrames:6,reverse:false,origin:'local'}});
  assert.throws(()=>segmentAnimation(animation,4,0),(e:any)=>e.code==='TEXT_STAGGER_EXCEEDS_DURATION'&&e.animationId==='benefit'&&e.segmentCount===4&&e.minimumDurationFrames===19);
  const valid=segmentAnimation({...animation,durationFrames:19},4,3);assert.equal(valid.startFrame,18);assert.equal(valid.durationFrames,1);
});
test('Capability context exposes target restrictions and source-specific trim eligibility without inventing a gate',async()=>{
  const f=await identityFixture(1);try{
    const c=motionCapabilityContext(f.project);assert.deepEqual(c.maskReveal.supportedTargetTypes,['TEXT']);assert.match(c.segmentedText.duration,/TOTAL/);assert.equal(c.rendering.framesPerCall,8);assert.ok(c.sourceEligibility?.every(s=>s.objects.every(o=>typeof o.trimPath==='boolean')));
  }finally{await f.cleanup();}
});
