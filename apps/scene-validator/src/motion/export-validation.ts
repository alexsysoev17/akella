import {spawn} from 'node:child_process';
export class ExportFailure extends Error{constructor(public code:string,message:string,public details?:unknown){super(message);this.name='ExportFailure';}}
/** Decode the actual completed container, without collecting raw frames in memory. */
export async function validateExportOutput(binary:string,file:string,expected:{width:number;height:number;fps:number;frames:number},signal:AbortSignal){
 signal.throwIfAborted();const child=spawn(binary,['-hide_banner','-i',file,'-map','0:v:0','-an','-f','null','-','-progress','pipe:1','-nostats'],{stdio:['ignore','pipe','pipe'],shell:false});
 let stdout='',stderr='';const stop=()=>child.kill('SIGTERM');signal.addEventListener('abort',stop,{once:true});
 try{
  await new Promise<void>((resolve,reject)=>{child.stdout.on('data',b=>stdout=(stdout+b).slice(-20000));child.stderr.on('data',b=>stderr=(stderr+b).slice(-20000));child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new ExportFailure('EXPORT_OUTPUT_INVALID','Completed MP4 cannot be decoded',{exitCode:code,stderr})));});signal.throwIfAborted();
  const stream=stderr.split('\n').find(s=>/Stream #0:.*Video:/.test(s))??'',size=stream.match(/,\s+(\d{1,5})x(\d{1,5})(?=\s|,)/),fps=stream.match(/([\d.]+) fps/),duration=stderr.match(/Duration: (\d+):(\d+):([\d.]+)/),counts=[...stdout.matchAll(/^frame=(\d+)/gm)].map(m=>Number(m[1]));
  const actual={width:Number(size?.[1]),height:Number(size?.[2]),fps:Number(fps?.[1]),frames:counts.at(-1)??0,durationSeconds:duration?Number(duration[1])*3600+Number(duration[2])*60+Number(duration[3]):NaN};
  // FFmpeg's human-readable container header rounds duration to two decimals.
  if(actual.width!==expected.width||actual.height!==expected.height||actual.fps!==expected.fps||actual.frames!==expected.frames||!Number.isFinite(actual.durationSeconds)||Math.abs(actual.durationSeconds-expected.frames/expected.fps)>.011)throw new ExportFailure('EXPORT_OUTPUT_INVALID','MP4 dimensions, FPS, duration or decoded frame count mismatch',{expected,actual});
  return {...actual,decodedAllFrames:true};
 }finally{signal.removeEventListener('abort',stop);if(child.exitCode===null)child.kill('SIGTERM');}
}
