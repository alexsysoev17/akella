import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {deflateSync} from 'node:zlib';
import {identityFixture} from './identity-fixture.js';
import {importFigmaExport,figmaRefreshSource,decodeFigmaPacket,assembleFigmaExport} from '../src/figma-mcp.js';
import {changeMotion} from '../src/motion/store.js';
import {loadProject} from '../src/project.js';
import type {FigmaSourceLink} from '../src/types.js';

async function fixture(){
 const f=await identityFixture(3);const doc=JSON.parse(await readFile(path.join(f.source,'scene.json'),'utf8'));
 doc.source={application:'Figma',pageId:'1:2',pageName:'Test'};
 doc.scenes.forEach((s:any,i:number)=>{s.figmaNodeId=`2:${i}`;s.children.forEach((n:any)=>n.parentId=s.figmaNodeId);});
 await writeFile(path.join(f.source,'scene.json'),JSON.stringify(doc));
 const link:FigmaSourceLink={version:1,fileKey:'abc123',fileUrl:'https://www.figma.com/design/abc123?node-id=1-3',pageId:'1:2',pageName:'Test',sectionId:'1:3',sectionName:'Storyboard',frameIds:['2:0','2:1','2:2'],capturedAt:new Date().toISOString(),transport:'figma-mcp'};
 const imported=await importFigmaExport({source:f.source,link,name:'Linked Figma',projectsRoot:path.join(f.root,'linked')});
 await changeMotion(imported.projectPath,{expectedRevision:'initial',request:'Animate QR',operations:[{type:'addAnimation',animation:{animationId:'qr-entry',targetId:'qr1',sceneId:'s1',effect:'fadeIn',startFrame:5,durationFrames:10,easing:'easeOutCubic',enabled:true,parameters:{from:0,to:1}}}]});
 return {...f,doc,link,linked:imported.projectPath};
}
test('Figma QR asset refresh preserves motion bytes, provenance, identity and previous source',async()=>{
 const f=await fixture();try{
  const motion=await readFile(path.join(f.linked,'motion/motion.json'));
  const old=await loadProject(f.linked);const image=path.join(f.source,'assets/qr.svg');
  await writeFile(image,(await readFile(image,'utf8')).replace('black','red'));
  const refreshed=await importFigmaExport({source:f.source,link:f.link,projectPath:f.linked});
  assert.equal(refreshed.config.projectId,old.config.projectId);
  assert.deepEqual(await readFile(path.join(f.linked,'motion/motion.json')),motion);
  assert.deepEqual((await figmaRefreshSource(f.linked)).frameIds,f.link.frameIds);
  assert.match(await readFile(path.join(f.linked,'source/assets/qr.svg'),'utf8'),/red/);
  const importId=refreshed.config.imports.at(-1)!.importId;
  assert.doesNotMatch(await readFile(path.join(f.linked,`history/imports/${importId}/source/assets/qr.svg`),'utf8'),/red/);
 }finally{await f.cleanup();}
});
test('Deleted/recreated QR and renamed logical identity leave current project untouched',async()=>{
 const f=await fixture();try{
  const before=await loadProject(f.linked);const motion=await readFile(path.join(f.linked,'motion/motion.json'));
  for(const change of ['id','name']){
   const doc=structuredClone(f.doc);doc.scenes[1].children[0][change==='id'?'figmaNodeId':'name']='replacement';
   await writeFile(path.join(f.source,'scene.json'),JSON.stringify(doc));
   await assert.rejects(importFigmaExport({source:f.source,link:f.link,projectPath:f.linked}),/identity\/name\/parent changed/);
   const after=await loadProject(f.linked);assert.equal(after.inspection.fingerprint,before.inspection.fingerprint);assert.deepEqual(after.config,before.config);assert.deepEqual(await readFile(path.join(f.linked,'motion/motion.json')),motion);
  }
 }finally{await f.cleanup();}
});
test('Wrong file/page/frame provenance cannot replace a linked source',async()=>{
 const f=await fixture();try{
  await assert.rejects(importFigmaExport({source:f.source,link:{...f.link,pageId:'9:9'},projectPath:f.linked}),/provenance/);
  await assert.rejects(importFigmaExport({source:f.source,link:{...f.link,fileKey:'other',fileUrl:'https://www.figma.com/design/other?node-id=1-3'},projectPath:f.linked}),/selection changed/);
 }finally{await f.cleanup();}
});
test('Corrupted or incomplete transfer packets fail before archive creation',()=>{
 assert.throws(()=>decodeFigmaPacket({encoding:'deflate-base64',data:'invalid'}));
 assert.throws(()=>decodeFigmaPacket({encoding:'deflate-base64',data:deflateSync(JSON.stringify({version:1,report:{errorCount:1}})).toString('base64')}),/Incomplete/);
});
test('Archive assembly keeps off-frame geometry/provenance and rejects incomplete assets',async()=>{
 const f=await fixture();try{
  const downloads=path.join(f.root,'downloads');await mkdir(downloads);
  const doc=structuredClone(f.doc);doc.scenes=[doc.scenes[1]];doc.scenes[0].index=0;doc.scenes[0].preview='previews/frame.png';doc.scenes[0].children[0].properties.y=300;
  const preview=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
  await writeFile(path.join(downloads,'preview-2-1.png'),preview);
  const svg=await readFile(path.join(f.source,'assets/qr.svg'),'utf8');
  const packet={version:1 as const,origin:{fileKey:f.link.fileKey,pageId:f.link.pageId,pageName:f.link.pageName,sectionId:f.link.sectionId,sectionName:f.link.sectionName},frameId:'2:1',texts:{'scene.json':JSON.stringify(doc),'assets/qr.svg':svg},embedded:[],manifest:[{path:'assets/qr.svg',bytes:Buffer.byteLength(svg)},{path:'previews/frame.png',bytes:preview.length}],report:{errorCount:0,nodes:2,warnings:[],errors:[],unsupportedProperties:[],fallbackExports:[]}};
  const result=await assembleFigmaExport({packets:[packet],frameIds:['2:1'],downloadsDirectory:downloads,outputDirectory:path.join(f.root,'assembled')});
  const exported=JSON.parse(await readFile(path.join(result.sourceDirectory,'scene.json'),'utf8'));
  assert.equal(exported.scenes[0].children[0].properties.y,300);
  assert.equal(JSON.parse(await readFile(path.join(result.sourceDirectory,'figma-source.json'),'utf8')).sectionId,'1:3');
  const corrupt=structuredClone(packet);corrupt.manifest[0].bytes++;
  await assert.rejects(assembleFigmaExport({packets:[corrupt],frameIds:['2:1'],downloadsDirectory:downloads,outputDirectory:path.join(f.root,'broken')}),/byte length mismatch/);
 }finally{await f.cleanup();}
});
