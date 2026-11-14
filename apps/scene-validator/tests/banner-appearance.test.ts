import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {Resvg} from '@resvg/resvg-js';
import {appearanceSchema,defaultAppearance,layerSchema,assertResize,validateDesign,applyEdits,type Layer,type Variant,type Appearance,type Resource} from '../src/banners/contracts.js';
import {renderVariant,workspace} from '../src/banners/render.js';

const layer=(extra:Partial<Layer>={}):Layer=>({id:'shape',name:'Fixture',kind:'shape',role:'panel',x:0,y:0,width:120,height:120,rotation:0,opacity:1,text:'',assetId:'',fontId:'',fontSize:32,lineHeight:1.1,color:'#000000',align:'left',shape:'rect',radius:0,...extra});
const appearance=(extra:Partial<Appearance>={}):Appearance=>({...structuredClone(defaultAppearance),...extra});
const variant=(layers:Layer[],width=120,height=120):Variant=>({id:'fixture',name:'Fixture',rationale:'Independent render fixture',width,height,background:'#FFFFFF',sourceIds:[],layers});
const linear=():NonNullable<Appearance['fill']>=>({type:'linear',from:{x:0,y:0},to:{x:1,y:0},radius:.5,stops:[{offset:0,color:'#000000',opacity:1},{offset:1,color:'#FFFFFF',opacity:1}]});

async function withRoot(work:(root:string)=>Promise<void>){
  const root=await mkdtemp(path.join(os.tmpdir(),'akella-appearance-'));
  try{await work(root);}finally{await rm(root,{recursive:true,force:true});}
}
async function rendered(root:string,v:Variant,resources:Resource[]=[],name='render'){
  const report=await renderVariant(root,v,resources,path.join(root,name));
  const svg=await readFile(path.join(root,name+'.svg'),'utf8');
  const image=new Resvg(svg,{font:{fontFiles:resources.filter(r=>r.kind==='font').map(r=>path.join(root,r.file)),loadSystemFonts:false}}).render();
  const pixels=image.pixels;
  return {report,svg,image,pixel:(x:number,y:number)=>[...pixels.subarray((y*image.width+x)*4,(y*image.width+x)*4+4)]};
}

test('appearance is optional for legacy documents and cannot contain SVG/code',()=>{
  assert.equal(layerSchema.parse(layer()).appearance,undefined);
  assert.throws(()=>appearanceSchema.parse(appearance({blur:129})));
  assert.throws(()=>appearanceSchema.parse({...appearance(),externalSvg:'<script/>'}));
  assert.throws(()=>appearanceSchema.parse(appearance({path:{data:'<path d="M0 0"/>',width:100,height:100}})));
});

test('legacy solid geometry retains identical rendered pixels',async()=>withRoot(async root=>{
  const v=variant([layer({color:'#115533'}),layer({id:'spot',shape:'ellipse',x:20,y:30,width:60,height:40,color:'#FFFF00'})]);
  const actual=await rendered(root,v);
  const expected=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#115533"/><ellipse cx="50" cy="50" rx="30" ry="20" fill="#FFFF00"/></svg>').render();
  assert.deepEqual(actual.image.pixels,expected.pixels);
}));

test('linear and radial gradients render smooth tonal changes in normalized coordinates',async()=>withRoot(async root=>{
  const a=await rendered(root,variant([layer({appearance:appearance({fill:linear()})})]));
  assert.ok(a.pixel(5,60)[0]<20);
  assert.ok(Math.abs(a.pixel(60,60)[0]-128)<5);
  assert.ok(a.pixel(114,60)[0]>235);
  const wide=await rendered(root,variant([layer({width:240,appearance:appearance({fill:linear()})})],240,120),[],'wide');
  assert.ok(Math.abs(a.pixel(60,60)[0]-wide.pixel(120,60)[0])<3);
  const radial=linear();radial.type='radial';radial.from={x:.5,y:.5};radial.to={x:.5,y:.5};radial.stops.reverse();radial.stops[0].offset=0;radial.stops[1].offset=1;
  const r=await rendered(root,variant([layer({appearance:appearance({fill:radial})})]),[],'radial');
  assert.ok(r.pixel(60,60)[0]>240);assert.ok(r.pixel(0,0)[0]<5);
}));

test('radial backgrounds remain centered when an unused to handle lies outside their circle',async()=>withRoot(async root=>{
  // Actual model-authored geometry: treating `to` as an SVG focus made this
  // entire background the final stop. Check pixels, not SVG field presence.
  const fill=linear();fill.type='radial';fill.from={x:.5,y:.36};fill.to={x:1,y:1};fill.radius=.8;
  for(const [width,height] of [[120,120],[240,120]]){
    const r=await rendered(root,variant([layer({width,height,appearance:appearance({fill})})],width,height),[],`radial-outside-${width}`);
    assert.ok(r.pixel(Math.floor(width*.5),Math.floor(height*.36))[0]<5,'center retains the first stop');
    assert.ok(r.pixel(width-1,height-1)[0]>250,'far corner reaches the last stop');
    const alternate=structuredClone(fill);alternate.to={x:0,y:0};
    const same=await rendered(root,variant([layer({width,height,appearance:appearance({fill:alternate})})],width,height),[],`radial-unused-${width}`);
    assert.deepEqual(r.image.pixels,same.image.pixels,'radial to does not affect the image');
  }
}));

test('soft shadow and glow extend beyond the object without a hard clipped edge',async()=>withRoot(async root=>{
  const shadow={color:'#000000',opacity:.7,blur:12,offsetX:12,offsetY:8};
  const v=variant([layer({x:30,y:30,width:40,height:40,color:'#FFFFFF',appearance:appearance({shadow})})]);
  const r=await rendered(root,v);
  const near=r.pixel(79,55)[0],far=r.pixel(94,55)[0];
  assert.ok(near<235&&near>80);assert.ok(far>near&&far>=250);assert.equal(r.pixel(10,10)[0],255);
  const glow=variant([layer({x:40,y:40,width:40,height:40,color:'#000000',appearance:appearance({shadow:{color:'#00FF00',opacity:1,blur:16,offsetX:0,offsetY:0}})})]);glow.background='#000000';
  const g=await rendered(root,glow,[],'glow');assert.ok(g.pixel(35,60)[1]>15);assert.equal(g.pixel(35,60)[0],0);
}));

test('blur softens authored vector edges and paths remain real stroked vectors',async()=>withRoot(async root=>{
  const pathLayer=layer({x:20,y:20,width:80,height:80,shape:'path',color:'#FF0000',appearance:appearance({path:{data:'M0 100 L50 0 L100 100 Z',width:100,height:100},stroke:{color:'#000000',opacity:1,width:4}})});
  const r=await rendered(root,variant([pathLayer]));
  assert.deepEqual(r.pixel(60,70).slice(0,3),[255,0,0]);assert.deepEqual(r.pixel(25,30).slice(0,3),[255,255,255]);assert.ok(r.svg.includes('<path d='));
  const blurred=await rendered(root,variant([layer({x:40,y:40,width:40,height:40,appearance:appearance({blur:10})})]),[],'blur');
  assert.ok(blurred.pixel(37,60)[0]<250&&blurred.pixel(37,60)[0]>100);assert.ok(blurred.pixel(42,60)[0]>0);
}));

test('image crop position, contain and rounded clipping affect actual pixels',async()=>withRoot(async root=>{
  const source=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="50" height="50" fill="#FF0000"/><rect x="50" width="50" height="50" fill="#0000FF"/></svg>').render().asPng();
  await writeFile(path.join(root,'image.png'),source);
  const resources:Resource[]=[{id:'image',name:'Fixture',kind:'image',file:'image.png',sha256:'fixture',width:100,height:50}];
  const a=layer({kind:'image',assetId:'image',x:20,y:20,width:80,height:80,appearance:appearance({imageFit:'cover',imagePosition:{x:0,y:0}})});
  const left=await rendered(root,variant([a]),resources);
  assert.deepEqual(left.pixel(60,60).slice(0,3),[255,0,0]);
  a.appearance!.imagePosition.x=1;
  const right=await rendered(root,variant([a]),resources,'right');
  assert.deepEqual(right.pixel(60,60).slice(0,3),[0,0,255]);
  a.appearance!.imageFit='contain';a.appearance!.imagePosition={x:.5,y:.5};
  const contain=await rendered(root,variant([a]),resources,'contain');
  assert.deepEqual(contain.pixel(60,25).slice(0,3),[255,255,255]);assert.deepEqual(contain.pixel(30,60).slice(0,3),[255,0,0]);
  a.appearance!.imageFit='cover';a.radius=40;
  const round=await rendered(root,variant([a]),resources,'round');
  assert.deepEqual(round.pixel(22,22).slice(0,3),[255,255,255]);assert.ok(round.pixel(60,60)[1]<10);
  const legacy=variant([layer({id:'background',color:'#FFFFFF'}),layer({kind:'image',assetId:'image',x:20,y:20,width:80,height:40})]);
  const patched=applyEdits(legacy,{message:'',patches:[{layerId:'shape',property:'radius',value:20}],addLayers:[],removeLayerIds:[],generatedAssets:[]});
  const clippedLegacy=await rendered(root,patched,resources,'rounded-legacy');
  assert.deepEqual(clippedLegacy.pixel(22,22).slice(0,3),[255,255,255]);assert.deepEqual(clippedLegacy.pixel(30,40).slice(0,3),[255,0,0]);
}));

test('letter spacing changes real glyph positions and measured wrapping consistently',async()=>withRoot(async root=>{
  const {stdout}=await promisify(execFile)(path.join(workspace,'data/knowledge/.venv/bin/python'),['-c','from PIL import ImageFont;import pathlib,sys,json;f=ImageFont.load_default(size=32);pathlib.Path(sys.argv[1]).write_bytes(f.path.getvalue());print(json.dumps(f.getname()))',path.join(root,'font.ttf')]);
  const [family,style]=JSON.parse(stdout);
  const resources:Resource[]=[{id:'font',name:'Bundled test font',kind:'font',file:'font.ttf',sha256:'fixture',family,style}];
  const a=layer({kind:'text',fontId:'font',text:'ABCD',x:10,y:10,width:180,height:80});
  const plain=await rendered(root,variant([a],220,120),resources);
  a.appearance=appearance({letterSpacing:4});
  const tracked=await rendered(root,variant([a],220,120),resources,'tracked');
  assert.ok(Math.abs((tracked.report.textBoxes[0] as any).width-(plain.report.textBoxes[0] as any).width-12)<.01);
  function inkRight(image:typeof plain){let right=0;for(let y=0;y<80;y++)for(let x=0;x<220;x++)if(image.pixel(x,y)[0]<100)right=Math.max(right,x);return right;}
  assert.ok(Math.abs(inkRight(tracked)-inkRight(plain)-12)<=2);
  a.text='AB CD';a.width=100;a.appearance.letterSpacing=10;
  const wrapped=await rendered(root,variant([a],220,120),resources,'wrapped');
  assert.deepEqual((wrapped.report.textBoxes[0] as any).lines,['AB','CD']);
}));

test('resizing preserves paint and contour identity while allowing effect dimensions to scale',()=>{
  const a=variant([layer({appearance:appearance({fill:linear(),shadow:{color:'#000000',opacity:.3,blur:8,offsetX:4,offsetY:2}})})]);
  const b=structuredClone(a);b.width=240;b.layers[0].width=240;b.layers[0].appearance!.shadow!.blur=16;b.layers[0].appearance!.shadow!.offsetX=8;
  assert.doesNotThrow(()=>assertResize(a,b));
  b.layers[0].appearance!.fill!.stops[0].color='#FF0000';assert.throws(()=>assertResize(a,b),/оформление/);
  const empty=variant([layer()]),defaults=structuredClone(empty);defaults.layers[0].appearance=appearance();assert.doesNotThrow(()=>assertResize(empty,defaults));
});

test('resizing can reorient gradient geometry while preserving stops, type and path identity',()=>{
  for(const type of ['linear','radial'] as const){
    const fill=linear();fill.type=type;
    const a=variant([layer({appearance:appearance({fill})})]);
    const b=structuredClone(a);b.width=180;b.height=300;
    b.layers[0].appearance!.fill!.from={x:.5,y:.2};b.layers[0].appearance!.fill!.to={x:.5,y:1};
    b.layers[0].appearance!.fill!.radius=.9;
    assert.doesNotThrow(()=>assertResize(a,b));
    const recolored=structuredClone(b);recolored.layers[0].appearance!.fill!.stops[0].color='#00FF00';
    assert.throws(()=>assertResize(a,recolored),/оформление/);
    const restyled=structuredClone(b);restyled.layers[0].appearance!.fill!.type=type==='linear'?'radial':'linear';
    assert.throws(()=>assertResize(a,restyled),/оформление/);
    const repathed=structuredClone(b);repathed.layers[0].appearance!.path={data:'M0 0 L1 1',width:1,height:1};
    assert.throws(()=>assertResize(a,repathed),/оформление/);
  }
});

test('typed appearance chat patch preserves unrelated content and rejects wrong types',()=>{
  const a=variant([layer(),layer({id:'second',color:'#FF0000'})]);
  const b=applyEdits(a,{message:'',patches:[{layerId:'shape',property:'appearance',value:appearance({fill:linear()})}],addLayers:[],removeLayerIds:[],generatedAssets:[]});
  assert.deepEqual(b.layers[1],a.layers[1]);assert.ok(b.layers[0].appearance?.fill);assert.equal(a.layers[0].appearance,undefined);
  assert.throws(()=>applyEdits(a,{message:'',patches:[{layerId:'shape',property:'appearance',value:'bad'}],addLayers:[],removeLayerIds:[],generatedAssets:[]}));
});

test('logo background exemption respects stacking and contain whitespace is not a collision',()=>{
  const logo=layer({id:'logo',kind:'logo',role:'logo',x:30,y:30,width:90,height:30,assetId:'logo'});
  const resources:Resource[]=[{id:'logo',kind:'logo',name:'Logo',file:'logo.svg',sha256:'fixture',width:300,height:100,clearspaceRatio:.5},{id:'photo',kind:'image',name:'Tall photo',file:'photo.png',sha256:'fixture',width:10,height:100}];
  const background=layer({id:'background',width:300,height:300});
  const v=variant([background,logo],300,300);
  assert.deepEqual(validateDesign(v,resources),[]);
  v.layers.push(layer({id:'foreground',x:20,y:20,width:140,height:80}));
  assert.ok(validateDesign(v,resources).some(x=>x.includes('foreground')));
  v.layers.pop();v.layers.push(layer({id:'photo',kind:'image',role:'hero',assetId:'photo',x:100,y:20,width:180,height:200}));
  assert.deepEqual(validateDesign(v,resources),[]);
});
