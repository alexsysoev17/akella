import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {identityFixture,node} from '../apps/scene-validator/tests/identity-fixture.js';
import {readMotion,changeMotion} from '../apps/scene-validator/src/motion/store.js';
import {renderNativeFrame,closeNativeRenderer} from '../apps/scene-validator/src/native/client.js';
import {exportVideo} from '../apps/scene-validator/src/motion/video.js';
import {motionSchema} from '../apps/scene-validator/src/motion/schema.js';
import {digest} from '../apps/scene-validator/src/harness/context.js';
const reports=process.argv.slice(2),out='data/harness/reports/stabilization-live-replay.json',results=[];
try{for(const input of reports){const report=JSON.parse(await readFile(path.join(input,'report.json'),'utf8'));for(const entry of report.cases.filter((c:any)=>c.taskSuccess&&c.sceneCount>1)){
 const count=entry.sceneCount,cross=entry.id.endsWith('transitions'),f=await identityFixture(count,scenes=>scenes.forEach((s,i)=>s.children=[node('circle'+i,cross?'Круг':'Круг '+(i+1),20+(cross?i*10:0),20+(cross?i*3:0),20+(cross?i*4:0),20+(cross?i*4:0)),node('square'+i,cross?'Квадрат':'Квадрат '+(i+1),90-(cross?i*5:0),45-(cross?i*3:0))]));
 try{const expected=motionSchema.parse(JSON.parse(await readFile(path.join(input,entry.id+'-motion.json'),'utf8'))),doc=await readMotion(f.project),next=(await changeMotion(f.project.root,{expectedRevision:doc.revision,request:'Replay actual saved live-provider operations',operations:[{type:'setProjectSettings',settings:expected.settings},{type:'setBlocks',blocks:expected.blocks},...entry.operations]})).document;
 const checks={sameCanonicalState:digest(expected)===digest(next.state),sameNativeFrames:true,mp4InputEquivalent:true};
 for(const proof of entry.frames){const frame=await renderNativeFrame(f.project,next.state,proof.frame,{encoding:'rgba'});if(createHash('sha256').update(frame.png).digest('hex')!==proof.hash)checks.sameNativeFrames=false;}
 const video=await exportVideo(f.project.root,()=>{},{renderer:'native'});if(!('frameDigests'in video)||!video.frameDigests.length)checks.mp4InputEquivalent=false;else for(const proof of video.frameDigests){const frame=await renderNativeFrame(f.project,next.state,proof.frame,{encoding:'rgba'});if(createHash('sha256').update(frame.png).digest('hex')!==proof.sha256)checks.mp4InputEquivalent=false;}
 results.push({input,id:entry.id,originalLiveRun:entry.runId,replayProviderCalls:0,checks,passed:Object.values(checks).every(Boolean)});
 }finally{await f.cleanup();}
 }}await mkdir(path.dirname(out),{recursive:true});await writeFile(out,JSON.stringify({kind:'SAVED_REAL_PROVIDER_OPERATIONS_REPLAY_NOT_NEW_LIVE_INFERENCE',results},null,2));console.log(JSON.stringify(results));if(results.some(r=>!r.passed))process.exitCode=1;
}finally{await closeNativeRenderer();}
