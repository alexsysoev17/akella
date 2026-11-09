/** Live model comparison on isolated source-only project copies. Never edits source project. */
import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {loadProject} from '../apps/scene-validator/src/project.js';
import {readMotion} from '../apps/scene-validator/src/motion/store.js';
import {executeMotion} from '../apps/scene-validator/src/motion/service.js';
import {renderNativeFrame,closeNativeRenderer} from '../apps/scene-validator/src/native/client.js';
const [source,requestFile,out,model]=process.argv.slice(2);
if(!source||!requestFile||!out||!model)throw Error('Usage: source-project request-file isolated-output model');
await mkdir(out,{recursive:true});
const root=path.join(out,'project');await mkdir(root);
await cp(path.join(source,'source'),path.join(root,'source'),{recursive:true});
const config=JSON.parse(await readFile(path.join(source,'project.json'),'utf8'));config.projectId=randomUUID();config.name+=' isolated '+model;
await writeFile(path.join(root,'project.json'),JSON.stringify(config));
const report:any={model,kind:'LIVE_PROVIDER_REAL_PROJECT',originalProject:source,isolatedProject:root};
const start=performance.now();
try{
 const project=await loadProject(root),before=await readMotion(project);
 const request=await readFile(requestFile,'utf8');
 const result:any=await executeMotion(project,{request,mode:'create',expectedRevision:before.revision,settings:{provider:'codex-sdk',model,reasoningEffort:'medium'}},stage=>console.info(JSON.stringify({model,stage,ms:Math.round(performance.now()-start)})),{executionRuntime:'agent',validationMode:'minimal'});
 report.result=result;report.runId=result.id;
 const doc=await readMotion(project);report.persisted=doc.revision!==before.revision;report.counts={animations:doc.state.animations.length,expressions:doc.state.expressions?.length,transitions:doc.state.objectTransitions?.length};
 if(report.persisted){report.frames=[];for(const frame of [0,30,60,70,149,150,180,239,240,270,doc.state.settings.durationFrames-1].filter(f=>f<doc.state.settings.durationFrames)){const r=await renderNativeFrame(project,doc.state,frame,{scale:.25,encoding:'png'});await writeFile(path.join(out,frame+'.png'),r.png);report.frames.push({frame,sha256:createHash('sha256').update(r.png).digest('hex')});}}
}catch(error){report.error=String(error);}finally{report.durationMs=performance.now()-start;await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await closeNativeRenderer();console.info(JSON.stringify({model,durationMs:report.durationMs,persisted:report.persisted,runId:report.runId,error:report.error}));}

if(report.error||!report.persisted)process.exitCode=1;
