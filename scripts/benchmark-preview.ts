/** Local, deterministic raster benchmark. No Agent/model calls or original project writes. */
import {cp,mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {loadProject} from '../apps/scene-validator/src/project.js';
import {readMotion} from '../apps/scene-validator/src/motion/store.js';
import {renderNativeFrame,closeNativeRenderer} from '../apps/scene-validator/src/native/client.js';
import {previewScales,type RenderQuality} from '../apps/scene-validator/src/native/quality.js';
const args=process.argv.slice(2),arg=(k:string)=>args[args.indexOf('--'+k)+1];
if(!args.includes('--project'))throw Error('--project PATH required');
const original=path.resolve(arg('project')),samples=Number(args.includes('--samples')?arg('samples'):5),frame=Number(args.includes('--frame')?arg('frame'):0);
if(!Number.isSafeInteger(samples)||samples<3||samples>50)throw Error('samples must be 3..50');
const directory=path.resolve(args.includes('--output')?arg('output'):'data/harness/reports/preview-quality-'+Date.now());
const temporary=await mkdtemp(path.join(tmpdir(),'akella-preview-benchmark-'));
const hash=async(file:string)=>createHash('sha256').update(await readFile(file)).digest('hex');
const before=await hash(path.join(original,'motion/motion.json'));
await cp(original,temporary,{recursive:true,filter:src=>![/\/motion\/(ai|qa|harness)(\/|$)/,/\/(history|validation|renders)(\/|$)/].some(r=>r.test(src))});
type Sample={ms:number;drawMs:number;readbackMs:number;wallMs:number;rss:number;reused:boolean;cacheHit:boolean;nativeLiveBytes:number};
const rows=Object.fromEntries(Object.keys(previewScales).map(k=>[k,[] as Sample[]])) as Record<RenderQuality,Sample[]>;
const percentile=(values:number[],p:number)=>[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)];
try{
 const project=await loadProject(temporary),doc=await readMotion(project);
 if(frame<0||frame>=doc.state.settings.durationFrames)throw Error('frame outside project');
 const stateHash=createHash('sha256').update(JSON.stringify(doc.state)).digest('hex');
 // Warm the renderer, decoded assets, font layout and every requested surface size.
 for(const scale of Object.values(previewScales))await renderNativeFrame(project,doc.state,frame,{scale,encoding:'rgba',cache:false,cacheNamespace:'benchmark'});
 const qualities=Object.keys(previewScales) as RenderQuality[];
 for(let round=0;round<samples;round++)for(let n=0;n<qualities.length;n++){
  const quality=qualities[(n+round)%qualities.length],scale=previewScales[quality],start=performance.now();
  const rendered=await renderNativeFrame(project,doc.state,frame,{scale,encoding:'rgba',cache:false,cacheNamespace:'benchmark'});
  rows[quality].push({ms:rendered.stats.milliseconds,drawMs:rendered.stats.drawMs,readbackMs:rendered.stats.encodeMs,wallMs:performance.now()-start,rss:rendered.memory.rss,reused:rendered.resourceReuse?.renderer===true,cacheHit:rendered.cacheHit,nativeLiveBytes:rendered.nativeMemory.liveBytes});
 }
 const summary=[];
 for(const quality of qualities){const scale=previewScales[quality];
  await renderNativeFrame(project,doc.state,frame,{scale,encoding:'rgba',cache:true,cacheNamespace:'benchmark-hot'});
  const start=performance.now(),hot=await renderNativeFrame(project,doc.state,frame,{scale,encoding:'rgba',cache:true,cacheNamespace:'benchmark-hot'}),s=rows[quality];
  summary.push({quality,scale,width:hot.width,height:hot.height,samples:s.length,meanRasterMs:s.reduce((a,b)=>a+b.ms,0)/s.length,medianRasterMs:percentile(s.map(r=>r.ms),.5),p95RasterMs:percentile(s.map(r=>r.ms),.95),meanDrawMs:s.reduce((a,b)=>a+b.drawMs,0)/s.length,medianDeliveryMs:percentile(s.map(r=>r.wallMs),.5),sampledPeakRSS:Math.max(...s.map(r=>r.rss)),resourceReuse:s.every(r=>r.reused),uncachedSamplesConfirmed:s.every(r=>!r.cacheHit),maximumTrackedLiveSurfaceBytesAfterRender:Math.max(...s.map(r=>r.nativeLiveBytes)),hotCacheHit:hot.cacheHit,hotDeliveryMs:performance.now()-start,cache:hot.cache});
 }
 const report={version:'preview-benchmark/1',createdAt:new Date().toISOString(),gitCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTree:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()?'modified':'clean',providerCalls:0,fixture:'isolated real-project copy',projectId:project.config.projectId,sourceFingerprint:project.inspection.fingerprint,logicalResolution:{width:doc.state.settings.width,height:doc.state.settings.height},fps:doc.state.settings.fps,durationFrames:doc.state.settings.durationFrames,frame,sampling:'same logical state/frame; all sizes warmed; interleaved rotated order; cache:false for timings; separate hot-cache probes',memoryCaveat:'RSS is sampled shared-process resident memory after frames, not isolated per-quality allocation or an OS peak trace',stateUnchanged:stateHash===createHash('sha256').update(JSON.stringify(doc.state)).digest('hex'),originalMotionUnchanged:before===await hash(path.join(original,'motion/motion.json')),summary,rows};
 await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'benchmark.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({directory,summary,originalMotionUnchanged:report.originalMotionUnchanged}));
}finally{await closeNativeRenderer();await rm(temporary,{recursive:true,force:true});}
