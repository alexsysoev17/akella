import {resumeVerifiedReplay} from '../apps/scene-validator/src/harness/recovery/resume.ts';
const args=process.argv.slice(2),value=(key:string)=>{const i=args.indexOf('--'+key);if(i<0||!args[i+1])throw Error('--'+key+' required');return args[i+1];};
console.log(JSON.stringify(await resumeVerifiedReplay(value('project'),value('run'),{replayRoot:value('copy'),resultFile:value('result'),resultHash:value('hash')})));
