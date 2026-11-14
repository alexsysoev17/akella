import test from 'node:test';
import assert from 'node:assert/strict';
import {artDirectionSchema,inspectedReviewSchema,validateArtDirection,validateInspections,typographyObservations} from '../src/banners/art-direction.js';
import {bannerProviderSchema,logoClearspace,validateDesign,type Resource,type Variant,type Layer} from '../src/banners/contracts.js';
import {validateProviderSchema} from '../src/harness/providers/schema.js';

const resource:Resource={id:'logo',kind:'logo',name:'Fixture',file:'fixture.svg',sha256:'fixture',width:300,height:100,clearspaceRatio:.5,
  clearspace:{top:.5,right:.5,bottom:.3,left:.5}};
const layer=(extra:Partial<Layer>):Layer=>({id:'l',name:'Layer',kind:'shape',role:'panel',x:0,y:0,width:300,height:100,
  rotation:0,opacity:1,text:'',assetId:'',fontId:'',fontSize:32,lineHeight:1.1,color:'#FFFFFF',align:'left',shape:'rect',radius:0,...extra});
const variant:Variant={id:'v',name:'Fixture',rationale:'Independent fixture',width:600,height:300,background:'#FFFFFF',sourceIds:['ref'],layers:[
  layer({id:'logo',kind:'logo',role:'logo',assetId:'logo',x:150,y:170}),
]};
test('asymmetric source clearance uses each edge and scales with the mark',()=>{
  assert.deepEqual(logoClearspace(resource,200),{top:100,right:100,bottom:60,left:100});
  assert.deepEqual(validateDesign(variant,[resource]),[]);
  assert.match(validateDesign({...variant,height:299},[resource]).join(),/охранное поле/);
  assert.match(validateDesign(variant,[{...resource,clearspace:undefined}]).join(),/охранное поле/);
  const outside=layer({id:'other',x:155,y:299,width:50,height:1});
  assert.match(validateDesign({...variant,layers:[...variant.layers,outside]},[resource]).join(),/other.*охранное поле/);
});
test('structured directing and inspection schemas are provider-compatible',()=>{
  for(const s of [artDirectionSchema,inspectedReviewSchema])assert.doesNotThrow(()=>validateProviderSchema(bannerProviderSchema(s)));
});
test('directions cannot silently target another variant, missing text, or unseen source',()=>{
  const v={...variant,layers:[...variant.layers,layer({id:'offer',kind:'text',role:'offer',text:'25%'})]};
  const plan:any={variants:[v],directions:[{variantId:'v',referenceId:'ref',readingOrder:[{layerId:'offer'}]}]};
  assert.doesNotThrow(()=>validateArtDirection(plan,['ref']));
  assert.throws(()=>validateArtDirection(plan,['other']),/пример/);
  assert.throws(()=>validateArtDirection({...plan,directions:[{...plan.directions[0],readingOrder:[{layerId:'logo'}]}]},['ref']),/текст/);
  assert.throws(()=>validateArtDirection({...plan,directions:[{...plan.directions[0],variantId:'other'}]},['ref']),/вариант/);
  const observations=typographyObservations([v],[{textBoxes:[{id:'offer',lines:['25%']}]}]);
  assert.deepEqual(observations[0].texts[0].measured.lines,['25%']);
  assert.equal(observations[0].texts[0].fontSize,32);
});
test('product KV can be part of reading order; inspection must cover every exact variant',()=>{
  const v={...variant,layers:[...variant.layers,layer({id:'product',kind:'image',role:'hero'})]};
  assert.doesNotThrow(()=>validateArtDirection({variants:[v],directions:[{variantId:'v',referenceId:'ref',readingOrder:[{layerId:'product',purpose:'product'}]}]} as any,['ref']));
  const review:any={inspections:[{variantId:'v'}],issues:[]};
  assert.doesNotThrow(()=>validateInspections(review,[v]));
  for(const inspections of [[],[{variantId:'unknown'}],[{variantId:'v'},{variantId:'v'}]])
    assert.throws(()=>validateInspections({...review,inspections},[v]),/каждый вариант/);
  assert.throws(()=>validateInspections({...review,issues:[{variantId:'unknown'}]},[v]),/неизвестный вариант/);
});
