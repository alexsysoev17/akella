import {ExportFailure,validateExportOutput} from './export-validation.js';
import {redactSecrets} from '../harness/security.js';
import {buildRegistry} from './registry.js';
import {renderDimensions,previewScales,type RenderQuality} from "../native/quality.js";
import {validateMotion} from "./operations.js";
import {numericQA} from "./qa/numeric.js";
import {statePresentation} from "./transitions.js";
import {compositionQA} from "../native/composition-qa.js";
import { spawn } from "node:child_process";
import { renderNativeFrame, renderingMode } from "../native/client.js";
import { exportBrowserVideo } from "./video-browser.js";
import { createRequire } from "node:module";
const ffmpegPath: unknown = createRequire(import.meta.url)("ffmpeg-static");
import { createHash, randomUUID } from "node:crypto";
import { stat, rm, rename } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { loadProject } from "../project.js";
import {
  safeDirectory,
  lockProject,
  atomicJson,
  inventory,
  fingerprint,
} from "../files.js";
import { readMotion } from "./store.js";
import {runtimeCode} from '../runtime-code.js';

export async function exportVideo(
  projectRoot: string,
  onProgress: (n: number, total: number) => void = () => {},
  options: {
    signal?: AbortSignal;
    renderer?: "native" | "browser-compat";
    draftQuality?:RenderQuality;
    exportJobId?:string;
    timeoutMs?:number;
    onStage?:(stage:string,diagnostics:Record<string,unknown>)=>void;
  } = {},
) {
  if ((options.renderer ?? renderingMode()) === "browser-compat") {
    if(options.draftQuality)throw Error('DRAFT_REQUIRES_NATIVE_RENDERER');
    return exportBrowserVideo(projectRoot, onProgress);
  }
  const jobId=options.exportJobId??randomUUID();if(!/^[a-f0-9-]{36}$/i.test(jobId))throw Error('INVALID_EXPORT_JOB_ID');
  const started=performance.now(),timeout=AbortSignal.timeout(options.timeoutMs??1200000),signal=AbortSignal.any([options.signal??new AbortController().signal,timeout]);
  const report:Record<string,unknown>={schemaVersion:'export-report/1',runtimeCode:runtimeCode.status(),createdAt:new Date().toISOString(),exportJobId:jobId,status:'RUNNING',exportPreset:options.draftQuality??'full',mode:options.draftQuality?'draft':'final',stage:'preflight',projectRevision:null,requestedWidth:null,requestedHeight:null,actualWidth:null,actualHeight:null,failingObjectId:null,failingFrame:null,failingInvariant:null,recoveryDecision:'No animation changes or LLM recovery during export',timings:{qaDurationMs:0,renderDurationMs:0,encodingDurationMs:0,outputValidationMs:0}};
  const directory=await safeDirectory(projectRoot,'motion/exports/'+jobId),reportFile=path.join(directory,'report.json');
  const persist=async()=>{report.elapsedMs=performance.now()-started;await atomicJson(reportFile,JSON.parse(redactSecrets(JSON.stringify(report).replaceAll(projectRoot,'<project>').replaceAll(process.cwd(),'<repository>'))));};
  const stage=async(value:string)=>{report.stage=value;options.onStage?.(value,report);signal.throwIfAborted();await persist();};
  let cancelEncoder:(()=>void)|undefined;
  let unlock:(()=>Promise<void>)|undefined,encoder:ReturnType<typeof spawn>|undefined,temporary:string|undefined,published:string|undefined;
  let project:Awaited<ReturnType<typeof loadProject>>|undefined,state:Awaited<ReturnType<typeof readMotion>>['state']|undefined;
  const timings=report.timings as Record<string,number>;
  try {
    await stage('preflight');unlock=await lockProject(projectRoot);signal.throwIfAborted();
    project=await loadProject(projectRoot);const doc=await readMotion(project);state=doc.state;report.projectRevision=doc.revision;report.projectId=project.config.projectId;
    const renderScale=options.draftQuality?previewScales[options.draftQuality]:1;
    if(!(renderScale>0))throw Error('INVALID_DRAFT_QUALITY');
    validateMotion(state,project);
    const requested=renderDimensions(state.settings.width,state.settings.height,renderScale);Object.assign(report,{requestedWidth:requested.width,requestedHeight:requested.height,fps:state.settings.fps,durationFrames:state.settings.durationFrames,durationSeconds:state.settings.durationFrames/state.settings.fps,projectResolution:{width:state.settings.width,height:state.settings.height}});
    await stage('motion-qa');const qaStarted=performance.now();
    const numeric=numericQA(state,'',statePresentation(project,state),{purpose:'export'});
    const numericFailed=numeric.checks.filter(c=>c.status==='FAILED');
    if(numericFailed.length){timings.qaDurationMs=performance.now()-qaStarted;report.failedChecks=numericFailed;report.qa={status:'FAILED',report:'qa.json'};await atomicJson(path.join(directory,'qa.json'),{status:'FAILED',numeric:numeric.checks,composition:'NOT_TESTED'});throw new ExportFailure('EXPORT_QA_FAILED','Motion QA failed',numericFailed);}
    await stage('composition-qa');
    const fullComposition=await compositionQA(project,state,'motion/qa/export-'+randomUUID(),{signal,scale:options.draftQuality?renderScale:1});
    const exportQA={level:options.draftQuality?'DRAFT_TECHNICAL':'FULL_TECHNICAL',renderScale:options.draftQuality?renderScale:1,numeric:numeric.checks,composition:fullComposition,status:[...numeric.checks,...fullComposition.checks].some(c=>c.status==='FAILED')?'FAILED':[...numeric.checks,...fullComposition.checks].some(c=>c.status==='WARNING')?'WARNING':'PASSED',artistic:'NOT_TESTED'};
    timings.qaDurationMs=performance.now()-qaStarted;report.qa={status:exportQA.status,level:exportQA.level,report:'qa.json',warnings:[...numeric.checks,...fullComposition.checks].filter(c=>c.status==='WARNING')};
    await atomicJson(path.join(directory,'qa.json'),exportQA);
    if(exportQA.status==='FAILED'){report.failedChecks=fullComposition.checks.filter(c=>c.status==='FAILED');throw new ExportFailure('EXPORT_QA_FAILED','Native Composition QA failed',report.failedChecks);}
    const binary = process.env.MOTION_FFMPEG_BIN ?? ffmpegPath;
    if (typeof binary !== "string")
      throw new ExportFailure(
        "EXPORT_ENCODER_FAILED", "FFmpeg недоступен. Переустановите зависимости или задайте MOTION_FFMPEG_BIN.",
      );
    const renders = await safeDirectory(projectRoot, "renders");
    const name = `${options.draftQuality?'draft-'+options.draftQuality:'motion'}-${randomUUID()}.mp4`;
    temporary = path.join(renders, "." + name);
    await stage('frame-render');let renderStarted=performance.now();
    const first = await renderNativeFrame(project, state, 0, {
      signal,
      encoding: "rgba",scale:renderScale,
    });
    timings.renderDurationMs+=performance.now()-renderStarted;
    const assertFrame=(frame:typeof first)=>{if(frame.width!==requested.width||frame.height!==requested.height||frame.png.byteLength!==frame.width*frame.height*4)throw new ExportFailure('EXPORT_RENDER_FAILED','Native RGBA dimensions/row bytes mismatch',{expected:requested,actual:{width:frame.width,height:frame.height,bytes:frame.png.byteLength}});};assertFrame(first);
    Object.assign(report,{actualWidth:first.width,actualHeight:first.height,renderer:first.renderer});
    const warnings = new Set(first.warnings);
    const usedFonts = new Map(first.fonts.map((font) => [font.family, font]));
    let stderr = "";
    await stage('encoding');const encoderStarted=performance.now();
    encoder = spawn(
      binary,
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "rawvideo",
        "-pixel_format",
        "rgba",
        "-video_size",
        `${first.width}x${first.height}`,
        "-framerate",
        String(state.settings.fps),
        "-i",
        "pipe:0",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-vf",
        "pad=ceil(iw/2)*2:ceil(ih/2)*2",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        temporary,
      ],
      { stdio: ["pipe", "pipe", "pipe"], shell: false },
    );
    const completed = new Promise<void>((resolve, reject) => {
      encoder!.once("error", e=>reject(new ExportFailure('EXPORT_ENCODER_FAILED',String(e))));
      encoder!.stderr!.on("data", (b) => {
        stderr = (stderr + b).slice(-8000);
      });
      encoder!.once("close", (code) =>
        code === 0 ? resolve() : reject(new ExportFailure('EXPORT_ENCODER_FAILED',`FFmpeg: ${stderr || code}`,{exitCode:code,stderr})),
      );
    });
    completed.catch(() => {});
    encoder!.stdin!.on("error", () => {});
    cancelEncoder=()=>{encoder?.kill('SIGTERM');};signal.addEventListener('abort',cancelEncoder,{once:true});
    const frameDigests: { frame: number; sha256: string }[] = [];
    for (let frame = 0; frame < state.settings.durationFrames; frame++) {
      signal.throwIfAborted();report.failingFrame=frame;report.stage='frame-render';renderStarted=performance.now();
      const rendered =
        frame === 0
          ? first
          : await renderNativeFrame(project, state, frame, {
              signal,
              encoding: "rgba",scale:renderScale,
            });
      if(frame!==0)timings.renderDurationMs+=performance.now()-renderStarted;assertFrame(rendered);
      rendered.warnings.forEach((w) => warnings.add(w));
      for (const font of rendered.fonts) usedFonts.set(font.family, font);
      const png = rendered.png;
      if (
        [
          0,
          Math.floor(state.settings.durationFrames / 2),
          state.settings.durationFrames - 1,
        ].includes(frame)
      )
        frameDigests.push({
          frame,
          sha256: createHash("sha256").update(png).digest("hex"),
        });
      report.stage='encoding';const writeStarted=performance.now();
      if(encoder!.exitCode!==null)throw new ExportFailure('EXPORT_ENCODER_FAILED','Encoder stopped before all frames');
      if (!encoder!.stdin!.write(png))
        await Promise.race([
          once(encoder!.stdin!, "drain"),
          completed.then(() => {
            throw new ExportFailure('EXPORT_ENCODER_FAILED','FFmpeg stopped before all frames');
          }),
        ]);
      timings.encodingDurationMs+=performance.now()-writeStarted;report.renderedFrames=frame+1;
      onProgress(frame + 1, state.settings.durationFrames);
    }
    encoder!.stdin!.end();const drainStarted=performance.now();await completed;timings.encodingDurationMs+=performance.now()-drainStarted;timings.encoderProcessWallMs=performance.now()-encoderStarted;
    signal.removeEventListener('abort',cancelEncoder);encoder=undefined;signal.throwIfAborted();report.failingFrame=null;
    await stage('output-validation');const validationStarted=performance.now();
    const output=await validateExportOutput(binary,temporary!,{width:Math.ceil(first.width/2)*2,height:Math.ceil(first.height/2)*2,fps:state.settings.fps,frames:state.settings.durationFrames},signal);
    timings.outputValidationMs=performance.now()-validationStarted;report.outputValidation=output;report.outputFileSize=(await stat(temporary!)).size;
    if (
      fingerprint(await inventory(project.sourceRoot)) !==
      project.inspection.fingerprint
    )
      throw new Error(
        "Исходники изменились во время рендера; результат не опубликован",
      );
    signal.throwIfAborted();
    await rename(temporary, path.join(renders, name));published=path.join(renders,name);
    temporary = undefined;
    await atomicJson(path.join(renders, name + ".json"), {
      mode:options.draftQuality?'draft':'final',quality:options.draftQuality??'full',renderScale,projectResolution:{width:state.settings.width,height:state.settings.height},renderResolution:{width:first.width,height:first.height},
      motionRevision: doc.revision,
      settings: state.settings,
      sourceFingerprint: project.inspection.fingerprint,
      warnings: [...warnings],
      renderer: first.renderer,
      fonts: [...usedFonts.values()],
      environment: first.environment,
      encodedSize: {
        width: Math.ceil(first.width / 2) * 2,
        height: Math.ceil(first.height / 2) * 2,
      },
      inputEncoding: "rgba",
      frameDigests,
      qa:exportQA,exportJobId:jobId,timings,outputValidation:output,
      renderedAt: new Date().toISOString(),
    });
    report.status='COMPLETED';report.outputFile=name;report.stage='completed';await persist();options.onStage?.('completed',report);
    return {
      exportJobId:jobId,timings,outputValidation:output,outputFileSize:report.outputFileSize,
      mode:options.draftQuality?'draft':'final',quality:options.draftQuality??'full',renderScale,projectResolution:{width:state.settings.width,height:state.settings.height},renderResolution:{width:first.width,height:first.height},qa:exportQA,
      file: name,
      revision: doc.revision,
      frames: state.settings.durationFrames,
      fps: state.settings.fps,
      warnings: [...warnings],
      renderer: first.renderer,
      fonts: [...usedFonts.values()],
      environment: first.environment,
      encodedSize: {
        width: Math.ceil(first.width / 2) * 2,
        height: Math.ceil(first.height / 2) * 2,
      },
      inputEncoding: "rgba",
      frameDigests,
    };
  } catch(error){
    const e=error as Error&{code?:string;details?:unknown};
    const code=options.signal?.aborted?'EXPORT_CANCELLED':timeout.aborted?'EXPORT_TIMEOUT':e.code?.startsWith('EXPORT_')?e.code:report.stage==='preflight'?'EXPORT_PREFLIGHT_FAILED':report.stage==='encoding'?'EXPORT_ENCODER_FAILED':report.stage==='output-validation'?'EXPORT_OUTPUT_INVALID':report.stage==='motion-qa'?'EXPORT_QA_FAILED':'EXPORT_RENDER_FAILED';
    const failed=(report.failedChecks as {name:string;target?:string;metrics?:Record<string,unknown>}[]|undefined)?.[0];
    const expression=state?.expressions?.find(x=>x.expressionId===failed?.target||'sourceAnimationId'in x&&x.sourceAnimationId===failed?.target);
    const target=expression??state?.animations.find(a=>a.animationId===failed?.target);
    const object=project&&target?buildRegistry(project.inspection.document,project.inspection.fingerprint).objects.find(o=>o.sourceInstances.some(i=>i.sceneId===target.sceneId&&i.sourceNodeId===target.targetId)):undefined;
    Object.assign(report,{status:code==='EXPORT_CANCELLED'?'CANCELLED':'FAILED',errorCode:code,message:e.message,failingObjectId:target?.targetId??failed?.target??null,failingObjectName:object?.name??failed?.target??null,failingInvariant:failed?.name??null,failingFrame:failed?.metrics?.frame??failed?.metrics?.peakFrame??report.failingFrame??null,details:e.details??null,stack:e.stack?.replaceAll(projectRoot,'<project>').replaceAll(process.cwd(),'<repository>')});
    if(typeof report.failingFrame==='number'&&state)report.failingTimeSeconds=report.failingFrame/state.settings.fps;
    if(published){await rm(published,{force:true});await rm(published+'.json',{force:true});}
    await persist();throw Object.assign(new ExportFailure(code,`${code}: ${e.message}; exportJobId=${jobId}`,report),{exportDiagnostics:report,cause:error});
  } finally {
    if(cancelEncoder)signal.removeEventListener('abort',cancelEncoder);encoder?.kill('SIGTERM');if(temporary)await rm(temporary,{force:true});await unlock?.();
  }
}
