import {mkdir,readFile,readdir,writeFile,cp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve(process.argv[2]??'.'),out=path.resolve(process.argv[3]??'data/harness/reports/direct-stabilization');
await mkdir(out,{recursive:true});
const load=async(p:string)=>import(pathToFileURL(path.join(root,p)).href);
const {identityFixture,node}=await load('apps/scene-validator/tests/identity-fixture.ts');
const {executeMotion}=await load('apps/scene-validator/src/motion/service.ts');
const {readMotion,changeMotion}=await load('apps/scene-validator/src/motion/store.ts');
const {evaluateMotion}=await load('apps/scene-validator/src/motion/evaluation.ts');
const {statePresentation}=await load('apps/scene-validator/src/motion/transitions.ts');
const {interpolateState}=await load('apps/scene-validator/src/motion/transition-runtime.ts');
const {renderNativeFrame,closeNativeRenderer}=await load('apps/scene-validator/src/native/client.ts');
const {exportVideo}=await load('apps/scene-validator/src/motion/video.ts');
const commit=process.argv[4]||execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const report:any={version:1,kind:'LIVE_DIRECT_SYNTHETIC',commit,sourceRoot:root,dirty:process.argv[4]?'ARCHIVED_BASELINE':execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(),model:process.argv[6]||'gpt-6.1-sol',reasoningEffort:process.argv[7]||'medium',cases:[]};
try{for(const scenario of (process.argv[5]??'1,4,10').split(',')){
 const count=parseInt(scenario),cross=scenario.endsWith('t');
 const f=await identityFixture(count,(scenes:any[])=>scenes.forEach((s,i)=>s.children=[node('circle'+i,cross?'Круг':'Круг '+(i+1),20+(cross?i*10:0),20+(cross?i*3:0),20+(cross?i*4:0),20+(cross?i*4:0)),node('square'+i,cross?'Квадрат':'Квадрат '+(i+1),90-(cross?i*5:0),45-(cross?i*3:0))]));
 const result:any={id:cross?count+'-scene-transitions':count===1?'relative-amplitude':count+'-scene-brief',sceneCount:count};const began=performance.now();
 try{
 let doc=await readMotion(f.project);doc=(await changeMotion(f.project.root,{expectedRevision:doc.revision,request:'synthetic fixture',operations:[{type:'setProjectSettings',settings:{...f.state.settings,width:160,height:96}},{type:'setBlocks',blocks:f.state.blocks},...(count===1?[{type:'addAnimation',animation:{animationId:'base',sceneId:'s0',targetId:'circle0',effect:'slideUp',startFrame:0,durationFrames:4,enabled:true,easing:'linear',parameters:{distance:40,mode:'in'}}},{type:'setExpression',expression:{expressionId:'inertia',type:'inertialOvershoot',sourceAnimationId:'base',sceneId:'s0',targetId:'circle0',startFrame:4,durationFrames:6,property:'y',enabled:true,parameters:{mode:'ae',settlingEnvelope:'smoothTail',amplitude:.2,frequency:2.5,decay:3,velocityLookbackFrames:2}}}]:[])]})).document;
 result.prompt=count===1?'Ослабь инерционные колебания у Круг 1 в два раза. Сохрани остальные параметры и движение.':`Создай анимацию ролика из ${count} сцен при 12 FPS. Сохрани существующие размеры, длительность, блоки и Figma-позиции. `+Array.from({length:count},(_,i)=>`В сцене ${i+1} (sceneId s${i}) на кадре ${i*12} Круг ${i+1} появляется снизу через фейд за 4 кадра с линейным движением; после остановки добавь настоящую процедурную инерцию y на 3 кадра (amplitude 0.1, frequency 2.5, decay 3, smoothTail). Квадрат ${i+1} одновременно появляется по скейлу от 0 до 1 через фейд за 4 кадра. `).join('')+'Выполни все сцены одним Direct-запросом с сохранением промежуточной работы. Не подменяй инерцию колебательными keyframes. Сохрани готовый результат.';
 if(cross)result.prompt=`Создай ролик из ${count} сцен при 12 FPS. Круг и Квадрат — одни логические объекты с разными Figma-состояниями. Сохрани размеры, FPS, блоки и длительность. В s0 на кадре 0 оба появляются снизу через фейд за 4 кадра, линейно, конечный offset 0, opacity 1. `+Array.from({length:count-1},(_,i)=>`На кадре ${8+i*12} оба объекта начинают согласованный переход из состояний s${i} в s${i+1} длительностью 4 кадра, линейно, переключение иерархии в конце. После этого перехода Круг получает настоящую transition-bound инерцию по y на 3 кадра с amplitude 0.1, frequency 2.5, decay 3 и smoothTail. `).join('')+'Используй referenceStates и общие метаданные пары сцен. Сохрани логическую идентичность и все конечные Figma-состояния. Не имитируй инерцию дополнительными ключами. Закончи весь запрос и сохрани результат.';
 const before=structuredClone(doc.state);
 const motion:any=await executeMotion(f.project,{request:result.prompt,mode:'edit',expectedRevision:doc.revision,settings:{provider:'codex-sdk',model:report.model,reasoningEffort:report.reasoningEffort}},(stage:string)=>console.info(JSON.stringify({case:result.id,stage})),{executionRuntime:'agent',validationMode:'minimal',signal:AbortSignal.timeout(300000),config:{directTimeoutRetries:1}});
 result.executionStatus=motion.status;result.runId=motion.id;
 const current=await readMotion(f.project),checks:any[]=[];
 if(count===1){const expected=structuredClone(before);expected.expressions[0].parameters.amplitude*=.5;checks.push({name:'onlyAmplitudeHalved',passed:JSON.stringify(expected)===JSON.stringify(current.state)});}
 else if(cross){const presentation=statePresentation(f.project,current.state);checks.push({name:'six-logical-transitions',passed:current.state.objectTransitions?.length===(count-1)*2});for(let i=0;i<count-1;i++){const transitions=(current.state.objectTransitions??[]).filter((t:any)=>t.fromSceneId==='s'+i&&t.toSceneId==='s'+(i+1));for(const t of transitions){checks.push({name:'timing-'+t.transitionId,passed:t.startFrame===8+i*12&&t.durationFrames===4});const refs=presentation[t.logicalObjectId],pose=interpolateState(refs[t.fromSceneId],refs[t.toSceneId],t,t.startFrame+t.durationFrames,current.state);checks.push({name:'reference-end-'+t.transitionId,passed:JSON.stringify(pose.matrix)===JSON.stringify(refs[t.toSceneId].normalized)});}checks.push({name:'transition-inertia-'+i,passed:(current.state.expressions??[]).filter((e:any)=>e.type==='inertialOvershoot'&&e.transitionId&&transitions.some((t:any)=>t.transitionId===e.transitionId)&&e.property==='y'&&e.startFrame===12+i*12&&e.durationFrames===3).length===1});}}
 else for(let i=0;i<count;i++){
 const start=evaluateMotion(current.state,i*12).nodes[JSON.stringify(['s'+i,'circle'+i])]??{},end=evaluateMotion(current.state,i*12+4).nodes[JSON.stringify(['s'+i,'circle'+i])]??{},squareStart=evaluateMotion(current.state,i*12).nodes[JSON.stringify(['s'+i,'square'+i])]??{},squareEnd=evaluateMotion(current.state,i*12+4).nodes[JSON.stringify(['s'+i,'square'+i])]??{};
 checks.push({name:'circle-slide-fade-'+i,passed:start.y>0&&Math.abs(start.opacity??1)<1e-6&&Math.abs(end.y??0)<1e-6&&Math.abs((end.opacity??0)-1)<1e-6});
 checks.push({name:'square-scale-fade-'+i,passed:Math.abs(squareStart.scale??squareStart.scaleX??1)<.002&&Math.abs(squareStart.opacity??1)<1e-6&&Math.abs((squareEnd.scale??squareEnd.scaleX??0)-1)<1e-6&&Math.abs((squareEnd.opacity??0)-1)<1e-6});
 const effects=(current.state.expressions??[]).filter((e:any)=>e.targetId==='circle'+i&&e.sceneId==='s'+i&&e.type==='inertialOvershoot'&&e.startFrame===i*12+4&&e.durationFrames===3);
 checks.push({name:'real-inertia-'+i,passed:effects.length===1&&Math.abs(effects[0].parameters.amplitude-.1)<1e-8&&effects[0].parameters.frequency===2.5&&effects[0].parameters.decay===3});
 }
 result.checks=checks;result.persisted=current.revision!==doc.revision;result.taskSuccess=result.persisted&&checks.every(c=>c.passed)&&motion.status==='applied';
 if(result.taskSuccess){result.frames=[];for(const frame of [...new Set([0,Math.floor(current.state.settings.durationFrames/2),current.state.settings.durationFrames-1])]){const rendered=await renderNativeFrame(f.project,current.state,frame,{encoding:'rgba'});const hash=createHash('sha256').update(rendered.png).digest('hex');result.frames.push({frame,hash});}
 const video=await exportVideo(f.project.root,()=>{},{renderer:'native'});result.mp4InputEquivalent=true;for(const proof of video.frameDigests??[]){const rendered=await renderNativeFrame(f.project,current.state,proof.frame,{encoding:'rgba'});if(createHash('sha256').update(rendered.png).digest('hex')!==proof.sha256)result.mp4InputEquivalent=false;}result.mp4Verified=Boolean(video.frameDigests?.length)&&result.mp4InputEquivalent;}
 result.operations=current.history.at(-1)?.operations;await writeFile(path.join(out,result.id+'-motion.json'),JSON.stringify(current.state,null,2));
 }catch(error){result.error=String(error);result.taskSuccess=false;}
 result.latencyMs=performance.now()-began;
 const runs=[];try{for(const id of await readdir(path.join(f.project.root,'motion/harness/runs'))){const run=JSON.parse(await readFile(path.join(f.project.root,'motion/harness/runs',id,'run.json'),'utf8'));runs.push(run);}}catch{}
 result.calls=runs.flatMap(r=>r.calls??[]).map(c=>({status:c.status,model:c.model,usage:c.usage,latencyMs:c.latencyMs}));result.providerCalls=result.calls.length;
 result.inputTokens=result.calls.reduce((n:number,c:any)=>n+(c.usage?.inputTokens??0),0);result.outputTokens=result.calls.reduce((n:number,c:any)=>n+(c.usage?.outputTokens??0),0);
 await writeFile(path.join(out,result.id+'-runs.json'),JSON.stringify(runs,null,2));
 for(const folder of ['ai','harness','direct-runs'])try{await cp(path.join(f.project.root,'motion',folder),path.join(out,result.id+'-diagnostics',folder),{recursive:true,filter:file=>!/[.](png|mp4|webm|zip)$/i.test(file)});}catch{}
 if(!result.taskSuccess){result.retainedProject=path.join(out,result.id+'-project');await cp(f.project.root,result.retainedProject,{recursive:true});}
 report.cases.push(result);await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.info(JSON.stringify({case:result.id,success:result.taskSuccess,calls:result.providerCalls,latencyMs:result.latencyMs,error:result.error}));await f.cleanup();
 if(result.calls.some((c:any)=>/RATE_LIMITED|usage limit|insufficient_quota/i.test(c.status))){report.stoppedReason='PROVIDER_RATE_LIMITED';await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));break;}
}}finally{await closeNativeRenderer();}
