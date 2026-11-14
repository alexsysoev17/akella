import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pinApprovedMotionImages,type ApprovedImageEvidence} from '../src/motion/approved-image-context.js';

test('Planner contact images pin exact verified bytes, deduplicate and cap at two; bad hashes and escaping paths remain diagnostics',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'approved-images-'));
  try{
    const corpus=path.join(root,'corpus'),run=path.join(root,'run');await mkdir(path.join(corpus,'evidence'),{recursive:true});await mkdir(run);
    const entries:ApprovedImageEvidence[]=[];
    for(let i=0;i<3;i++){
      const bytes=Buffer.concat([Buffer.from([255,216,255]),Buffer.from('contact-'+i)]),relativePath=`evidence/frame${i}.jpg`,sha256=createHash('sha256').update(bytes).digest('hex');
      await writeFile(path.join(corpus,relativePath),bytes);entries.push({referenceId:'ref'+i,relativePath,sha256,sourceSha256:'a'.repeat(64),timecode:[i,i+1],caption:'Temporal sequence',width:640,height:360});
    }
    const pinned=await pinApprovedMotionImages([entries[0],entries[0],entries[1],entries[2]],run,path.join(corpus,'evidence-index.json'));
    assert.equal(pinned.images.length,2);assert.equal(pinned.evidence[0].sourceSha256,'a'.repeat(64));assert.deepEqual(pinned.diagnostics,[]);
    assert.deepEqual(await readFile(pinned.images[0]),await readFile(path.join(corpus,entries[0].relativePath)));
    await symlink(path.join(corpus,'evidence/frame0.jpg'),path.join(corpus,'evidence/link.jpg'));
    const rejected=await pinApprovedMotionImages([{...entries[0],sha256:'b'.repeat(64)},{...entries[0],relativePath:'evidence/../../secret.jpg'},{...entries[0],relativePath:'evidence/link.jpg'}],run,path.join(corpus,'evidence-index.json'));
    assert.equal(rejected.images.length,0);assert.equal(rejected.diagnostics.length,3);
  }finally{await rm(root,{recursive:true,force:true});}
});
