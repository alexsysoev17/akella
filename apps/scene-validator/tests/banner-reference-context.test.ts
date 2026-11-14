import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {chooseReferenceImages,prepareBrandContext,pinnedReferenceImages,modelBrandContext,selectReferenceAssets,groundReferenceStudies} from '../src/banners/brand-context.js';
import {assertCreativeRepair,assertLayoutOnly} from '../src/banners/service.js';
import {assertResize,defaultAppearance,bannerProviderSchema,planSchema,editSchema,intentSchema,reviewSchema,editIntentSchema,type Variant,type Layer,type Appearance} from '../src/banners/contracts.js';
import {validateProviderSchema} from '../src/harness/providers/schema.js';
import {brandDirectory} from '../src/brands/library.js';
import {hash} from '../src/banners/storage.js';
import {workspace} from '../src/banners/workspace.js';

const reference=(id:string,familyId=id,width=1200,height=600,extra:Record<string,unknown>={})=>({
  id,title:'Композиция '+id,body:'Композиция рекламного баннера',kind:'example',status:'reviewed',polarity:'positive',
  authority:'observed',scope:'fixture',review:{by:'independent synthetic fixture'},links:[] as string[],
  evidence:[{image:'fixture.png'}],design:{pageId:'selected',familyId,format:{width,height},role:'advertisement'},...extra,
});
const layer=(extra:Partial<Layer>):Layer=>({id:'fixture',name:'Fixture',kind:'shape',role:'panel',x:0,y:0,width:100,height:100,
  rotation:0,opacity:1,text:'',assetId:'',fontId:'',fontSize:32,lineHeight:1.1,color:'#000000',align:'left',shape:'rect',radius:0,...extra});
const fixture=():Variant=>({id:'banner',name:'Fixture',rationale:'Independent contract fixture',width:1200,height:600,background:'#FFFFFF',sourceIds:['source-a'],layers:[
  layer({id:'logo',kind:'logo',role:'logo',assetId:'original-logo',x:60,y:60,width:180,height:60}),
  layer({id:'claim',kind:'text',role:'offer',text:'Скидка 25% на молоко с картой клуба',fontId:'brand-font',x:60,y:220,width:500,height:160}),
  layer({id:'kv',kind:'image',role:'hero',assetId:'original-kv',x:650,y:100,width:450,height:430}),
]});
const gradient=():Appearance=>({...structuredClone(defaultAppearance),fill:{type:'linear',from:{x:0,y:0},to:{x:1,y:1},radius:.5,
  stops:[{offset:0,color:'#006600',opacity:1},{offset:1,color:'#AAFF00',opacity:1}]}});
const promptContext=(evidence:any[])=>({brand:'fixture',snapshot:'snapshot',audience:'consumer',profile:{resources:[],requiredEvidence:['warning'],palette:['#00AA00']},
  assets:[],evidence,resources:[],retrievalMode:['hybrid'],imageOrder:[]});

const asset=(id:string,extra:any={})=>({id,kind:'asset',status:'reviewed',polarity:'positive',media:{sha256:id},design:{use:'reusable'},...extra});
const packedReference=(id:string,uses:any[])=>reference(id,id,1200,600,{design:{referencePack:{version:1,scope:'campaign',sourceNodeId:id,assetUses:uses,anchors:[]}}});
test('selected reference assets precede semantic hits, reserve brief slots and cannot import old replacement KV',()=>{
  const parts=Array.from({length:20},(_,i)=>asset('part-'+i)),queries=Array.from({length:10},(_,i)=>asset('product-'+i)),oldKV=asset('old-kv');
  const refs=[packedReference('ref',parts.map(r=>({assetId:r.id,role:'material',policy:'preserve'})).concat([{assetId:'old-kv',role:'hero-reference',policy:'replace-with-brief'}]))];
  const result=selectReferenceAssets(refs,[...parts,...queries,oldKV],[oldKV,...queries]);
  assert.equal(result.candidates.length,24);assert.equal(result.candidates.filter(r=>r.id.startsWith('part-')).length,16);
  assert.equal(result.candidates.filter(r=>r.id.startsWith('product-')).length,8);assert.ok(!result.candidates.some(r=>r.id==='old-kv'));
  assert.equal(result.recipes[0].assetUses.find((u:any)=>u.assetId==='old-kv').available,false);
  assert.deepEqual(result.recipes[0].omittedAssetIds,['part-16','part-17','part-18','part-19']);
  assert.ok(result.preserveOriginalIds.has('part-0'));assert.ok(!result.preserveOriginalIds.has('product-0'));
});
test('conditional source products remain available without becoming mandatory offer facts',()=>{
  const product=asset('basket'),historic=asset('expired-price');
  const refs=[packedReference('ref',[{assetId:'basket',role:'hero-reference',policy:'match-brief'},
    {assetId:'expired-price',role:'hero-reference',policy:'replace-with-brief'}])];
  const actual=selectReferenceAssets(refs,[product,historic],[historic]);
  assert.deepEqual(actual.candidates.map(r=>r.id),['basket']);
  assert.equal(actual.recipes[0].assetUses[0].available,true);assert.equal(actual.recipes[0].assetUses[0].requiresBriefMatch,true);
  assert.equal(actual.recipes[0].assetUses[1].available,false);
});
test('source studies resolve actual same-page compositions and original campaign materials',()=>{
  const make=(id:string,extra:any={})=>reference(id,id,1200,600,{design:{pageId:'page',sectionId:'section',campaignId:'campaign',audience:'consumer',role:'advertisement',...extra}});
  const selected=make('selected'),material=make('material',{referencePack:{version:1}}),typographic=make('type',{sectionId:'type-section',campaignId:'type-campaign',referencePack:{version:1}});
  const wrongPage=make('wrong-page',{pageId:'other',sectionId:'type-section',referencePack:{version:1}});
  const kv=make('kv',{role:'key-visual-study'});
  const study={design:{pageId:'page',sectionId:'type-section'}};
  assert.deepEqual(groundReferenceStudies([selected],[selected,material,typographic,wrongPage,kv],[study],{audience:'consumer'}).map(r=>r.id),['selected','material','type']);
  assert.deepEqual(chooseReferenceImages([kv,selected]).map(r=>r.id),['selected']);
});
test('reference packs deduplicate bytes, reject unapproved assets, preserve source geometry and appear once in model input',()=>{
  const a=asset('original'),alias=asset('alias',{media:{sha256:'original'}}),negative=asset('negative',{polarity:'negative'});
  const refs=[packedReference('first',[{assetId:'original',role:'background',policy:'preserve',bounds:{x:.123456789,y:0,width:1,height:1}}]),
    packedReference('second',[{assetId:'alias',role:'material',policy:'preserve'},{assetId:'negative',role:'decor',policy:'preserve'}])];
  const before=structuredClone(refs),selected=selectReferenceAssets(refs,[a,alias,negative],[]);
  assert.deepEqual(selected.candidates.map(r=>r.id),['original']);assert.equal(selected.recipes[1].assetUses[0].assetId,'original');
  assert.equal(selected.recipes[1].assetUses[0].sourceAssetId,'alias');assert.equal(selected.recipes[1].assetUses[1].available,false);
  const context={...promptContext(refs),referenceRecipes:selected.recipes},projected=modelBrandContext(context);
  assert.equal(projected.referenceRecipes[0].assetUses[0].bounds.x,.1235);assert.equal(projected.evidence[0].design.referencePack,undefined);
  assert.equal(context.referenceRecipes[0].assetUses[0].bounds.x,.123456789);assert.deepEqual(refs,before);
});

test('model projection keeps the exact negative warning, scope and source without positive styling',()=>{
  const negative=reference('warning','family',1200,600,{polarity:'negative',body:'Do not use this campaign.\nOnly this specific example is prohibited.',scope:'employee campaign only',
    evidence:[{nodeId:'source:1',url:'https://example.com/source',region:{x:.1234567,y:.2}}],
    design:{pageId:'page',sectionId:'section',annotation:'Do not use',audience:'employee',usage:'campaign-scoped',campaignId:'campaign',
      principles:['A positive styling idea from the surrounding board'],geometrySummary:{effects:[{radius:50}]}}});
  const context=promptContext([negative]),before=structuredClone(context),actual=modelBrandContext(context).evidence[0];
  assert.equal(actual.body,negative.body);assert.equal(actual.scope,negative.scope);assert.equal(actual.polarity,'negative');
  assert.deepEqual(actual.source,[{nodeId:'source:1',url:'https://example.com/source',region:{x:.1234567,y:.2}}]);
  assert.equal(actual.design.annotation,'Do not use');assert.equal(actual.design.audience,'employee');
  assert.equal(actual.design.geometrySummary,undefined);assert.equal(actual.design.principles,undefined);
  assert.deepEqual(context,before);
});

test('ready recipes replace competing broad geometry in the prompt without erasing stored evidence',()=>{
  const item=reference('packed','family',1200,600,{design:{geometrySummary:{texts:[{nodeId:'unresolved-child',fontSize:42}]},principles:['Retain dimensional ribbon.']}});
  const context={...promptContext([item]),referenceRecipes:[{referenceId:'packed',anchors:[{nodeId:'resolved-headline',bounds:{x:.1,y:.2,width:.5,height:.3}}]}]};
  const before=structuredClone(context),projected=modelBrandContext(context);
  assert.equal(projected.evidence[0].design.geometrySummary,undefined);
  assert.equal(projected.evidence[0].design.geometrySource,'referenceRecipes');
  assert.deepEqual(projected.evidence[0].design.principles,['Retain dimensional ribbon.']);
  assert.equal(projected.referenceRecipes[0].anchors[0].nodeId,'resolved-headline');
  assert.deepEqual(context,before);
});

test('model geometry marks approximation, retains active effects and leaves exact source untouched',()=>{
  const exact=97.4000015258789,unknown={type:'FUTURE_REFRACTION',visible:true,intensity:.7654321,mode:'custom',noise:{octaves:7}};
  const item=reference('example','family',1200,600,{design:{pageId:'page',role:'advertisement',geometrySummary:{
    texts:[{relativeBounds:{x:1.234567,y:2,width:300.123456,height:80},fontSize:40.0000001}],
    gradients:[{paint:{stops:[{position:.1234567,color:{r:.7654321}}],transform:{m00:.3333333333}}}],
    effects:[{nodeId:'blur',effectiveVisible:true,blendMode:'NORMAL',effects:[{type:'FOREGROUND_BLUR',visible:true,radius:exact,offset:{x:0,y:4},color:{r:0,g:0,b:0,a:.25},
      spread:0,authoredColor:{space:'DEFAULT'},refraction:0,blurOpType:'PROGRESSIVE',startOffset:{x:.1234567,y:0},endOffset:{x:1,y:1},startRadius:2}]},
      {nodeId:'hidden',effects:[{type:'DROP_SHADOW',visible:false,radius:4}]},
      {nodeId:'shadow',effects:[{type:'DROP_SHADOW',visible:true,radius:5.555555,offset:{x:2,y:3},color:{r:0,g:0,b:0,a:.4},spread:1,blendMode:'MULTIPLY',authoredColor:{space:'DEFAULT'}}]},
      {nodeId:'unknown',effects:[unknown]}]}}});
  const context=promptContext([item]),before=structuredClone(context),model=modelBrandContext(context),geometry=model.evidence[0].design.geometrySummary;
  assert.equal(geometry.approximation.decimalPlaces,4);assert.match(geometry.approximation.scope,/model view only/);
  assert.equal(geometry.texts[0].relativeBounds.x,1.2346);assert.equal(geometry.gradients[0].paint.transform.m00,.3333);
  assert.deepEqual(geometry.effects.map((n:any)=>n.nodeId),['blur','shadow','unknown']);
  const blur=geometry.effects[0].effects[0];assert.equal(blur.radius,97.4);assert.equal(blur.offset,undefined);assert.equal(blur.color,undefined);assert.equal(blur.refraction,undefined);
  assert.equal(blur.blurOpType,'PROGRESSIVE');assert.deepEqual(blur.startOffset,{x:.1235,y:0});assert.deepEqual(blur.endOffset,{x:1,y:1});assert.equal(blur.startRadius,2);
  const shadow=geometry.effects[1].effects[0];assert.equal(shadow.radius,5.5556);assert.deepEqual(shadow.offset,{x:2,y:3});assert.equal(shadow.blendMode,'MULTIPLY');assert.equal(shadow.authoredColor,undefined);
  assert.deepEqual(geometry.effects[2].effects[0],{...unknown,intensity:.7654});
  model.profile.palette.push('#FFFFFF');geometry.texts[0].fontSize=80;assert.deepEqual(context,before);
});

test('shared study prose is stored once while unique reference principles and source IDs survive',()=>{
  const common='Keep a quiet text region.',principles=[common,'Use one dominant product.'];
  const study=reference('study','none',1200,600,{body:common,design:{pageId:'page',sectionId:'section',role:'composition-study',principles}});
  const a=reference('a','family',1200,600,{body:common+' Source text: Example.',design:{pageId:'page',sectionId:'section',role:'advertisement',principles}});
  const b=reference('b','family',600,1200,{body:'A unique body.',design:{pageId:'page',sectionId:'section',role:'advertisement',principles:['A unique frame observation.']}});
  const context=promptContext([study,a,b]),before=structuredClone(context),actual=modelBrandContext(context).evidence;
  assert.equal(actual[0].body,undefined);assert.deepEqual(actual[0].design.principles,principles);
  assert.equal(actual[1].studyId,'study');assert.equal(actual[1].body,'Source text: Example.');assert.equal(actual[1].design.principles,undefined);
  assert.equal(actual[2].body,'A unique body.');assert.deepEqual(actual[2].design.principles,['A unique frame observation.']);
  assert.deepEqual(actual.map((r:any)=>r.id),['study','a','b']);assert.deepEqual(context,before);
});

test('model projection does not deduplicate approximate wording or join studies across pages',()=>{
  const study=reference('study','none',1200,600,{body:'Green backdrop.',design:{pageId:'page-a',sectionId:'section',role:'composition-study',principles:['Use a green backdrop.']}});
  const item=reference('other-page','family',1200,600,{body:'Green backdrop. Exact text.',design:{pageId:'page-b',sectionId:'section',role:'advertisement',principles:['Other scoped rule.']}});
  const actual=modelBrandContext(promptContext([study,item])).evidence;
  assert.equal(actual[0].body,'Green backdrop.');assert.equal(actual[1].body,'Green backdrop. Exact text.');assert.equal(actual[1].studyId,undefined);
  assert.deepEqual(actual[1].design.principles,['Other scoped rule.']);
});

test('reference images exclude font specifications, assets, negatives and unreviewed drafts',()=>{
  const records=[reference('font-spec','type',1200,600,{kind:'rule'}),reference('qr-guide','qr',1200,600,{kind:'rule'}),
    reference('asset-sheet','assets',1200,600,{kind:'asset'}),reference('negative','bad',1200,600,{polarity:'negative'}),
    reference('mixed','mixed',1200,600,{polarity:'mixed'}),reference('draft','draft',1200,600,{status:'unreviewed'}),
    reference('missing-image','no-image',1200,600,{evidence:[{file:'source.json'}]}),reference('banner')];
  assert.deepEqual(chooseReferenceImages(records).map(r=>r.id),['banner']);
});

test('four composition families precede paired resize images and closest aspect leads each family',()=>{
  const records=[reference('a-tall','a',600,1200),reference('a-wide','a'),reference('a-wide-duplicate','a'),
    reference('b-wide','b'),reference('b-tall','b',600,1200),reference('c-wide','c'),reference('d-wide','d')];
  const selected=chooseReferenceImages(records,{width:1200,height:600});
  assert.deepEqual(selected.slice(0,4).map(r=>r.design.familyId),['a','b','c','d']);
  assert.equal(selected[0].id,'a-wide');
  assert.deepEqual(new Set(selected.slice(4).map(r=>r.id)),new Set(['a-tall','b-tall']));
  assert.ok(!selected.some(r=>r.id==='a-wide-duplicate'));
  assert.equal(selected.length,6);
});

test('resize can prefer the original creative family without losing other directions',()=>{
  const selected=chooseReferenceImages([reference('new-wide','new'),reference('original-tall','original',600,1200),reference('third','third')],
    {width:1200,height:600,familyIds:['original']},3);
  assert.equal(selected[0].id,'original-tall');
  assert.deepEqual(new Set(selected.map(r=>r.design.familyId)),new Set(['original','new','third']));
});

test('reference image choice retains the strongest semantic direction despite nearby aspect differences',()=>{
  const photographic=reference('photo-human-products','photo-family',1119,480,{retrieval:{rerank:2.2}});
  const pool=[photographic,...Array.from({length:5},(_,i)=>reference('unrelated-card-'+i,'card-family-'+i,1200,600,{retrieval:{rerank:-1}}))];
  const selected=chooseReferenceImages(pool,{width:1200,height:600});
  assert.ok(selected.some(r=>r.id===photographic.id),'Exact aspect matches must not erase the semantically strongest photographic direction');
});

test('semantic campaign order survives format matching and recipe duplicates',()=>{
 const a=reference('seasonal-tall','seasonal',600,1200),b=reference('grocery-wide','basket'),c=reference('grocery-variation','basket-2'),d=reference('photo','photo');
 (b.design as any).campaignId='grocery';(c.design as any).campaignId='grocery';
 assert.deepEqual(chooseReferenceImages([a,b,c,d],{width:1200,height:600}).map(r=>r.id),['seasonal-tall','grocery-wide','photo']);
});

test('actual Codex strict schema admission accepts optional persisted appearance on the wire',()=>{
 for(const schema of [planSchema,editSchema,intentSchema,reviewSchema,editIntentSchema])assert.doesNotThrow(()=>validateProviderSchema(bannerProviderSchema(schema)));
 const wire=bannerProviderSchema(planSchema) as any;
 assert.ok(wire.properties.variants.items.properties.layers.items.required.includes('appearance'));
 assert.doesNotThrow(()=>planSchema.parse({message:'legacy',variants:[fixture()],generatedAssets:[]}));
});

test('legacy examples without geometry remain usable, deduplicated and bounded',()=>{
  const first=reference('first');delete (first as any).design;
  const second=reference('second');delete (second as any).design;
  const input=[first,first,second];
  assert.deepEqual(chooseReferenceImages(input,{},2).map(r=>r.id),['first','second']);
  assert.deepEqual(chooseReferenceImages(input,{},0),[]);
  assert.equal(input.length,3);
});

test('creative repair permits gradients, decorative shapes and hierarchy changes while preserving content',()=>{
  const before=fixture(),after=structuredClone(before);
  after.background='#006600';after.layers[1].fontSize=58;after.layers[1].width=540;
  after.layers[2].x=700;
  after.layers.unshift(layer({id:'lighting',width:1200,height:600,appearance:gradient()}));
  after.layers.push(layer({id:'curve',role:'decoration',shape:'path',x:800,y:400,width:350,height:180,
    appearance:{...structuredClone(defaultAppearance),path:{data:'M0 100 Q50 0 100 100 Z',width:100,height:100}}}));
  assert.doesNotThrow(()=>assertCreativeRepair([before],[after]));
  assert.deepEqual(after.layers.filter(l=>l.kind!=='shape').map(l=>[l.id,l.text,l.assetId]),before.layers.map(l=>[l.id,l.text,l.assetId]));
  const next=structuredClone(after);next.layers=next.layers.filter(l=>l.id!=='curve');
  assert.doesNotThrow(()=>assertCreativeRepair([after],[next]));
});

test('creative repair rejects changed claims, replaced KV/logo and changed protected identities',()=>{
  const changes:Array<(v:Variant)=>void>=[
    v=>{v.layers[1].text='Скидка 50%';},v=>{v.layers[2].assetId='different-product';},v=>{v.layers[0].assetId='different-logo';},
    v=>{v.layers[0].opacity=.5;},v=>{v.layers[0].rotation=10;},v=>{v.layers[1].role='support';},
    v=>{v.layers[1].id='replacement-claim';},v=>{v.layers.splice(2,1);},
    v=>{v.layers.push(layer({id:'new-image',kind:'image',role:'decoration',assetId:'unrequested-object'}));},
  ];
  for(const change of changes){const before=fixture(),after=structuredClone(before);change(after);assert.throws(()=>assertCreativeRepair([before],[after]));}
});

test('creative repair keeps exact variant identities and canvas sizes',()=>{
  const before=fixture(),second={...structuredClone(before),id:'second'},after=structuredClone(before);
  after.width=1000;assert.throws(()=>assertCreativeRepair([before],[after]));
  after.width=before.width;after.id='replacement';assert.throws(()=>assertCreativeRepair([before],[after]));
  assert.throws(()=>assertCreativeRepair([before],[]));
  assert.throws(()=>assertCreativeRepair([before,second],[before,before]));
  assert.doesNotThrow(()=>assertCreativeRepair([before,second],[second,before]));
});

test('legacy resize stays layout-only and does not inherit creative paint/decor permissions',()=>{
  const before=fixture(),resized=structuredClone(before);resized.width=600;resized.height=1200;
  resized.layers[1].fontSize=48;resized.layers[1].width=480;resized.layers[2].x=70;resized.layers[2].y=600;
  assert.doesNotThrow(()=>assertResize(before,resized));
  assert.throws(()=>assertLayoutOnly([before],[resized]));
  const paint=structuredClone(before);paint.layers.push(layer({id:'new-decoration',role:'decoration'}));
  assert.doesNotThrow(()=>assertCreativeRepair([before],[paint]));assert.throws(()=>assertResize(before,paint));
  const changed=structuredClone(before);changed.background='#006600';assert.throws(()=>assertResize(before,changed));
  changed.background=before.background;changed.layers[1].fontId='other-font';assert.throws(()=>assertResize(before,changed));
});

test('prepared context isolates reference pages and retains linked negative evidence (local lexical fixture)',async()=>{
  const brand='fixture-reference-'+randomUUID(),base=brandDirectory(brand),directory=await mkdtemp(path.join(os.tmpdir(),'banner-reference-'));
  try{
    await mkdir(base,{recursive:true});
    const source=JSON.stringify({nodeIds:['1:1']}),image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ZL8AAAAASUVORK5CYII=','base64');
    await writeFile(path.join(base,'source.json'),source);await writeFile(path.join(base,'fixture.png'),image);
    const evidence=[{nodeId:'1:1',file:'source.json',fileSha256:hash(Buffer.from(source)),image:'fixture.png',imageSha256:hash(image)}];
    const records=[reference('selected-wide','family'),reference('selected-tall','family',600,1200),
      reference('other-page','family',1200,600,{design:{pageId:'excluded',familyId:'family',format:{width:1200,height:600}}}),
      reference('linked-negative','bad',1200,600,{polarity:'negative',body:'Композиция: так больше не делаем'}),
      reference('font-spec','type',1200,600,{kind:'rule',mandatory:true}),
      reference('source-material','material',1200,600,{kind:'asset',media:{file:'fixture.png',sha256:hash(image),width:1,height:1},design:{use:'reusable'}})].map(r=>({...r,evidence}));
    (records[0].design as any).referencePack={version:1,scope:'fixture campaign',sourceNodeId:'1:1',coordinateSpace:'normalized-visual-frame',anchors:[],
      assetUses:[{nodeId:'1:1',assetId:'source-material',role:'material',policy:'preserve',localToNormalized:[1,0,0,0,1,0]}]};
    records[0].links=['other-page','linked-negative','source-material'];
    await writeFile(path.join(base,'records.json'),JSON.stringify(records));
    await writeFile(path.join(base,'authoring.json'),JSON.stringify({version:1,snapshot:'fixture',resources:[],requiredEvidence:['font-spec'],referencePageIds:['selected'],authoringMode:'reference-adaptation'}));
    await writeFile(path.join(base,'catalog.json'),JSON.stringify({brand,snapshot:'fixture',source:'source.json',records:'records.json',authoring:'authoring.json',coverage:{fixture:true}}));
    // Build without embeddings: this exercises the real Python bridge and filtering without an AI call.
    await promisify(execFile)(path.join(workspace,'data/knowledge/.venv/bin/python'),[path.join(workspace,'scripts/knowledge/brand_library.py'),'build',brand],{timeout:30000});
    const {context}=await prepareBrandContext(brand,[],'Композиция',directory,{width:1200,height:600,familyIds:['family']});
    const committed=await readFile(path.join(directory,'brand-context.json'),'utf8');
    const staged=await prepareBrandContext(brand,[],'Композиция',directory,{width:600,height:1200,familyIds:['family'],persistContext:false});
    assert.equal(await readFile(path.join(directory,'brand-context.json'),'utf8'),committed);
    assert.ok(staged.context.referenceImages.length>0);
    const adaptation=await prepareBrandContext(brand,[],'Композиция',directory,{width:1200,height:600,persistContext:false});
    assert.deepEqual(new Set(adaptation.context.referenceImages.map(r=>r.id)),new Set(['selected-wide','selected-tall']));
    assert.ok(!adaptation.context.retrieval.some((r:any)=>r.request.filters?.hasReferencePack===true),'A ready material pack must not hide semantically relevant examples');
    assert.ok(!staged.context.retrieval.some((r:any)=>r.request.filters?.hasReferencePack===true),'Original resize family takes precedence over pack readiness');
    assert.equal(context.referenceRecipes[0].referenceId,'selected-wide');assert.equal(context.referenceRecipes[0].assetUses[0].available,true);
    const material=context.resources.find(r=>r.id==='source-material');assert.equal((material?.source as any)?.preserveOriginalBounds,true);
    assert.deepEqual(context.assets.map(r=>r.id),['source-material']);
    assert.deepEqual(new Set(context.referenceImages.map(r=>r.id)),new Set(['selected-wide','selected-tall']));
    assert.ok(context.evidence.some(r=>r.id==='font-spec'));
    assert.ok(context.evidence.some(r=>r.id==='linked-negative'&&r.polarity==='negative'),'Linked negative example must survive as evidence, not an inspiration image');
    assert.ok(context.retrievalMode.every(mode=>mode==='lexical'));
    const pins=await pinnedReferenceImages(directory,context);assert.equal(pins.length,2);
    assert.deepEqual(await readFile(pins[0]),image);
    await writeFile(pins[0],'modified');await assert.rejects(pinnedReferenceImages(directory,context),/изменился/);
  }finally{await rm(base,{recursive:true,force:true});await rm(directory,{recursive:true,force:true});}
});
