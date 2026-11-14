import test from 'node:test';
import assert from 'node:assert/strict';
import {assertResize,validateDesign,applyEdits,defaultAppearance,type Variant,type Resource} from '../src/banners/contracts.js';
import {assertLayoutOnly,undoBannerProject,recoverBannerCreationDraft} from '../src/banners/service.js';
import {containedFile,projectDirectory,atomic,saveProject,readBannerContext} from '../src/banners/storage.js';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
const defaults={rotation:0,opacity:1,text:'',assetId:'',fontId:'',fontSize:32,lineHeight:1.1,color:'#000000',align:'left' as const,shape:'rect' as const,radius:0};
const resources:Resource[]=[{id:'logo',name:'Original',kind:'logo',file:'logo.svg',sha256:'fixture',width:300,height:100,clearspaceRatio:.5},
  {id:'font',name:'Font',kind:'font',file:'font.ttf',sha256:'fixture'},{id:'photo',name:'Photo',kind:'image',file:'photo.png',sha256:'fixture'}];
const fixture=():Variant=>({id:'v1',name:'Variant',rationale:'Fixture',width:1200,height:600,background:'#FFFFFF',sourceIds:[],layers:[
  {...defaults,id:'logo',name:'Logo',kind:'logo',role:'logo',assetId:'logo',x:60,y:60,width:180,height:60},
  {...defaults,id:'copy',name:'Headline',kind:'text',role:'headline',fontId:'font',text:'Скидка 25%',x:60,y:200,width:500,height:100},
  {...defaults,id:'product',name:'Product',kind:'image',role:'hero',assetId:'photo',x:650,y:130,width:450,height:400},
]});
test('reflow preserves exact text and image identity across aspect ratios',()=>{const a=fixture(),b=structuredClone(a);b.width=600;b.height=900;b.layers[1].y=250;b.layers[1].width=400;b.layers[1].fontSize=50;b.layers[2].x=100;b.layers[2].y=450;b.layers[2].width=350;assert.doesNotThrow(()=>assertResize(a,b));});
test('resize rejects content substitutions even with same layer count',()=>{for(const key of ['text','assetId','fontId','color'] as const){const a=fixture(),b=structuredClone(a);b.layers[1][key]='different';assert.throws(()=>assertResize(a,b));}});
test('resize rejects lost and duplicated layer identities',()=>{const a=fixture(),b=structuredClone(a);b.layers[2].id=b.layers[1].id;assert.throws(()=>assertResize(a,b));b.layers.pop();assert.throws(()=>assertResize(a,b));});
test('original logo ratio, edge clearspace and neighboring content checked',()=>{const a=fixture();assert.deepEqual(validateDesign(a,resources),[]);a.layers[0].x=10;assert.ok(validateDesign(a,resources).some(e=>e.includes('край')));a.layers[0].x=60;a.layers[1].y=120;assert.ok(validateDesign(a,resources).some(e=>e.includes('охранное')));a.layers[0].width=240;assert.ok(validateDesign(a,resources).some(e=>e.includes('пропорции')));});
test('foreign brand assets cannot resolve by filename or arbitrary path',()=>{const a=fixture();a.layers[2].assetId='../another-brand/photo';assert.ok(validateDesign(a,resources).some(e=>e.includes('неизвестный ассет')));});
test('co-branding requires an explicitly pinned partner mark and keeps one primary',()=>{
 const a=fixture(),partner={...resources[0],id:'partner',logoRole:'partner' as const};
 a.layers.push({...a.layers[0],id:'partner',assetId:'partner',x:350});
 assert.deepEqual(validateDesign(a,[...resources,partner]),[]);
 assert.ok(validateDesign(a,[...resources,{...partner,logoRole:undefined}]).some(e=>e.includes('основной')));
 a.layers=a.layers.filter(l=>l.id!=='logo');assert.ok(validateDesign(a,[...resources,partner]).some(e=>e.includes('основной')));
});
test('layout repair cannot rewrite claims, change canvas or omit variants',()=>{const a=fixture(),b=structuredClone(a);b.layers[1].text='Скидка 50%';assert.throws(()=>assertLayoutOnly([a],[b]));b.layers[1].text=a.layers[1].text;b.width=200;assert.throws(()=>assertLayoutOnly([a],[b]));assert.throws(()=>assertLayoutOnly([a],[]));});
test('ordinary layout repair cannot restyle gradient, crop, or tracking',()=>{
  const a=fixture();a.layers[1].appearance={...defaultAppearance,fill:{type:'linear',from:{x:0,y:0},to:{x:1,y:1},radius:1,stops:[{offset:0,color:'#000000',opacity:1},{offset:1,color:'#FFFFFF',opacity:1}]}};
  for(const change of [(b:Variant)=>{b.layers[1].appearance!.fill!.from.x=.5;},(b:Variant)=>{b.layers[1].appearance!.imagePosition.x=0;},(b:Variant)=>{b.layers[1].appearance!.letterSpacing=3;}]){
    const b=structuredClone(a);change(b);assert.doesNotThrow(()=>assertResize(a,b));assert.throws(()=>assertLayoutOnly([a],[b]),/appearance/);
  }
  const b=structuredClone(a);b.layers[1].y+=30;assert.doesNotThrow(()=>assertLayoutOnly([a],[b]));
});
test('logo clearspace uses a path contour rather than its empty viewport',()=>{
  const a=fixture();a.layers.push({...defaults,id:'curve',name:'Curve',kind:'shape',role:'decoration',x:0,y:0,width:600,height:600,shape:'path',appearance:{...defaultAppearance,path:{data:'M400 400 H500 V500 H400 Z',width:600,height:600}}});
  assert.deepEqual(validateDesign(a,resources),[]);
  a.layers.at(-1)!.appearance!.path!.data='M80 80 H100 V100 H80 Z';assert.ok(validateDesign(a,resources).some(x=>x.includes('curve: входит')));
  a.layers.at(-1)!.appearance!.path!.data='M400 400 H500 V500 H400 Z';a.layers.at(-1)!.rotation=180;assert.ok(validateDesign(a,resources).some(x=>x.includes('curve: входит')));
});
test('opaque logo badges protect the mark from earlier scenery, not later or translucent content',()=>{
 const a=fixture(),logo=a.layers[0];
 const scene={...defaults,id:'ribbon',name:'Ribbon',kind:'image' as const,role:'decoration' as const,assetId:'photo',x:0,y:0,width:500,height:500};
 const badge={...defaults,id:'badge',name:'Logo badge',kind:'shape' as const,role:'panel' as const,x:30,y:30,width:240,height:120,radius:20,color:'#FFFFFF'};
 a.layers=[scene,badge,...a.layers];assert.deepEqual(validateDesign(a,resources),[]);
 badge.opacity=.9;assert.ok(validateDesign(a,resources).some(x=>x.includes('ribbon: входит')));badge.opacity=1;
 badge.width=190;assert.ok(validateDesign(a,resources).some(x=>x.includes('ribbon: входит')));badge.width=240;
 a.layers=[badge,logo,scene,...a.layers.slice(3)];assert.ok(validateDesign(a,resources).some(x=>x.includes('ribbon: входит')));
});
test('a full-canvas lighting surface is background only when below the logo',()=>{
 const a=fixture(),light={...defaults,id:'light',name:'Lighting',kind:'shape' as const,role:'decoration' as const,x:0,y:0,width:1200,height:600,opacity:.2};
 a.layers.unshift(light);assert.deepEqual(validateDesign(a,resources),[]);
 a.layers.shift();a.layers.push(light);assert.ok(validateDesign(a,resources).some(x=>x.includes('light: входит')));
});
test('chat text patch preserves all unmentioned fields and object identities',()=>{const a=fixture(),b=applyEdits(a,{message:'Changed',patches:[{layerId:'copy',property:'text',value:'Новый текст'}],addLayers:[],removeLayerIds:[],generatedAssets:[]});assert.equal(b.layers[1].text,'Новый текст');b.layers[1].text=a.layers[1].text;assert.deepEqual(b,a);assert.equal(a.layers[1].text,'Скидка 25%');});
test('unknown patch target and wrong property type cannot corrupt document',()=>{const a=fixture();assert.throws(()=>applyEdits(a,{message:'',patches:[{layerId:'missing',property:'x',value:30}],addLayers:[],removeLayerIds:[],generatedAssets:[]}));assert.throws(()=>applyEdits(a,{message:'',patches:[{layerId:'copy',property:'fontSize',value:'broken'}],addLayers:[],removeLayerIds:[],generatedAssets:[]}));});
test('media containment resolves symlinks and blocks escape',async()=>{const root=await mkdtemp(path.join(os.tmpdir(),'banner-security-'));try{await writeFile(path.join(root,'safe.txt'),'ok');await symlink(os.tmpdir(),path.join(root,'outside'));assert.equal(await containedFile(root,'safe.txt'),path.join(await import('node:fs/promises').then(m=>m.realpath(root)),'safe.txt'));await assert.rejects(containedFile(root,'../outside.txt'));await assert.rejects(containedFile(root,'outside'));}finally{await rm(root,{recursive:true,force:true});}});
test('successive undo follows content ancestry instead of toggling previous undo',async()=>{
  const id=randomUUID(),root=projectDirectory(id);
  try{
    for(let revision=1;revision<=3;revision++){
      const v=fixture();v.layers[1].text='Revision '+revision;
      const p={version:1 as const,id,brand:'fixture',brandSnapshot:'fixture',title:'Undo fixture',brief:'Test',revision,parentRevision:revision>1?revision-1:null,
        variants:[v],resources:[],messages:[],updatedAt:new Date().toISOString()};
      const directory=path.join(root,'revisions',String(revision));await mkdir(directory,{recursive:true});
      for(const ext of ['png','svg','metrics.json'])await writeFile(path.join(directory,'v1.'+ext),'fixture');
      await atomic(path.join(directory,'document.json'),p);await saveProject(p);
      await atomic(path.join(directory,'brand-context.json'),{reference:'Revision '+revision});
    }
    const first=await undoBannerProject(id,3);assert.equal(first.variants[0].layers[1].text,'Revision 2');assert.equal(first.revision,4);
    assert.deepEqual(await readBannerContext(first),{reference:'Revision 2'});
    const second=await undoBannerProject(id,4);assert.equal(second.variants[0].layers[1].text,'Revision 1');assert.equal(second.parentRevision,null);
    assert.deepEqual(await readBannerContext(second),{reference:'Revision 1'});
    await assert.rejects(undoBannerProject(id,5),/Нет предыдущей версии/);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('failed draft context cannot replace the committed revision evidence',async()=>{
 const id=randomUUID(),root=projectDirectory(id);try{
  await mkdir(path.join(root,'revisions','1'),{recursive:true});
  await atomic(path.join(root,'brand-context.json'),{reference:'legacy'});
  await atomic(path.join(root,'revisions','1','brand-context.json'),{reference:'committed'});
  await mkdir(path.join(root,'revisions','2'));await atomic(path.join(root,'revisions','2','brand-context.json'),{reference:'uncommitted draft'});
  assert.deepEqual(await readBannerContext({id,revision:1}),{reference:'committed'});
  assert.deepEqual(await readBannerContext({id,revision:0}),{reference:'legacy'});
 }finally{await rm(root,{recursive:true,force:true});}
});
test('local creation recovery refuses published content, stale runs and paid KV resubmission',async()=>{
 const id=randomUUID(),runId=randomUUID(),root=projectDirectory(id);
 const p={version:1 as const,id,brand:'fixture',brandSnapshot:'fixture',title:'Recovery fixture',brief:'Test',revision:1,
   variants:[],resources:[],messages:[],updatedAt:new Date().toISOString(),job:{id:runId,status:'failed' as const,stage:'Failed'}};
 try{
  await mkdir(root,{recursive:true});await saveProject(p);
  await assert.rejects(recoverBannerCreationDraft(id,runId),/without published content/);
  p.revision=0;await saveProject(p);await assert.rejects(recoverBannerCreationDraft(id,randomUUID()),/current failed creation/);
  const draft=path.join(root,'runs',runId,'design');await mkdir(draft,{recursive:true});
  await atomic(path.join(draft,'raw-response.json'),{message:'Provider draft',variants:[fixture()],generatedAssets:[{id:'gen-product',name:'Product',prompt:'A single product cutout',referenceIds:['original'],style:'3d',background:'cutout'}]});
  await assert.rejects(recoverBannerCreationDraft(id,runId),/separate job reconciliation/);
 }finally{await rm(root,{recursive:true,force:true});}
});
