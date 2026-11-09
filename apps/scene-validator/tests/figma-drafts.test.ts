import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {FigmaDrafts,selectNamed} from '../src/figma-drafts.js';
import {createProject} from '../src/importer.js';
import {identityFixture} from './identity-fixture.js';
test('Named selection distinguishes test 1 from test 10 and rejects ambiguity',()=>{
 const items=[{name:'тест 1',id:1},{name:'тест 10',id:10}];
 assert.equal(selectNamed(items,'возьми «тест 1»','раскадровку').id,1);
 assert.throws(()=>selectNamed(items,'тест 1 или тест 10','раскадровку'),/Уточни/);
 assert.throws(()=>selectNamed(items,'тест 11','раскадровку'),/Уточни/);
 assert.equal(selectNamed([{name:'хакатон?'}],'в файле «хакатон?»','файл').name,'хакатон?');
});
test('Empty projects persist without fake scenes; interrupted imports retain conversation and become retryable',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'figma-draft-test-'));
 try{const store=new FigmaDrafts(root,root),d=await store.create();assert.equal(d.status,'empty');assert.deepEqual(await readdir(root),['.drafts']);
  d.status='importing';d.messages.push({role:'user',text:'test'});await store.save(d);
  const reopened=new FigmaDrafts(root,root);await reopened.recover();const recovered=await reopened.get(d.projectId);
  assert.equal(recovered?.status,'failed');assert.equal(recovered?.messages[0].text,'test');assert.equal((await reopened.list()).length,1);
  assert.equal(await reopened.get('11111111-1111-1111-1111-111111111111'),undefined);
  await assert.rejects(reopened.get('../escape'),/Invalid/);
  await assert.rejects(reopened.start(d.projectId,''),/Напиши/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('Import keeps the empty-project ID and verifies source copy',async()=>{
 const f=await identityFixture(1);try{
  const id='11111111-1111-4111-8111-111111111111';
  const result=await createProject({name:'Imported draft',source:f.source,projectsRoot:path.join(f.root,'draft-projects'),initialProjectId:id});
  assert.equal(result.config.projectId,id);assert.equal(result.copyVerified,true);
  assert.equal(result.inspection.document.scenes.length,1);
 }finally{await f.cleanup();}
});

test('Chunk transfer rejects mixed snapshots, missing chunks and corrupted bytes',async()=>{
 const {joinFigmaChunks}=await import('../src/figma-runner.js');
 const data='a'.repeat(42000)+'b'.repeat(32000);let checksum=2166136261;for(let i=0;i<data.length;i++)checksum=Math.imul(checksum^data.charCodeAt(i),16777619)>>>0;
 const chunks=[0,42000].map(offset=>({encoding:'deflate-base64-chunk',offset,total:data.length,checksum,data:data.slice(offset,offset+42000)}));
 assert.equal(joinFigmaChunks(chunks).data,data);
 assert.throws(()=>joinFigmaChunks(chunks.slice(0,1)),/Incomplete/);
 assert.throws(()=>joinFigmaChunks([chunks[0],{...chunks[1],checksum:1}]),/Invalid/);
 assert.throws(()=>joinFigmaChunks([chunks[0],{...chunks[1],data:'c'.repeat(32000)}]),/changed/);
});

test('PNG signature compares pixels across compression levels and detects changed pixels',async()=>{
 const {pngPixels}=await import('../src/figma-png.js');const {deflateSync,inflateSync}=await import('node:zlib');
 const chunk=(type:string,data:Buffer)=>{const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);out.write(type,4);data.copy(out,8);return out;};
 const png=(filter:number,level:number,change=false)=>{
  const header=Buffer.alloc(13);header.writeUInt32BE(2,0);header.writeUInt32BE(2,4);header[8]=8;header[9]=6;
  const pixels=Buffer.from([1,2,3,255,4,5,6,128,7,8,9,255,10,11,12,128]);if(change)pixels[0]=99;
  const raw=Buffer.alloc(18);for(let y=0;y<2;y++){raw[y*9]=filter;for(let x=0;x<8;x++){
   const left=x>=4?pixels[y*8+x-4]:0,up=y?pixels[x]:0,corner=y&&x>=4?pixels[x-4]:0;
   const p=left+up-corner,a=Math.abs(p-left),b=Math.abs(p-up),c=Math.abs(p-corner);
   const prediction=[0,left,up,(left+up)>>>1,a<=b&&a<=c?left:b<=c?up:corner][filter];raw[y*9+1+x]=(pixels[y*8+x]-prediction)&255;
  }}
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(raw,{level})),chunk('IEND',Buffer.alloc(0))]);
 };
 const baseline=pngPixels(png(0,0),inflateSync);
 for(let filter=0;filter<5;filter++)assert.deepEqual(pngPixels(png(filter,9),inflateSync),baseline);
 assert.notEqual(pngPixels(png(0,9,true),inflateSync).hash,baseline.hash);
 assert.throws(()=>pngPixels(png(0,9).subarray(0,30),inflateSync),/Invalid/);
});

test('Recovery recognizes an import committed before its final chat status was saved',async()=>{
 const f=await identityFixture(1);try{
  const root=path.join(f.root,'recovery-projects'),store=new FigmaDrafts(root,root),d=await store.create();
  d.status='importing';await store.save(d);
  await createProject({name:'Recovered',source:f.source,projectsRoot:root,initialProjectId:d.projectId});
  await store.recover();const ready=await store.get(d.projectId);
  assert.equal(ready?.status,'ready');assert.equal(ready?.messages.at(-1)?.stage,'ready');assert.deepEqual(await store.list(),[]);
 }finally{await f.cleanup();}
});
