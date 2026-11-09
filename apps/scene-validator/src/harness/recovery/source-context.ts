import type { CodeRepairWorkspace } from "./code-repair.js";
/** Source remains complete in quarantine. Only bounded, exact line spans go to the model. */
export function codeSourceContext(files: CodeRepairWorkspace["files"], byteBudget: number) {
  const originalBytes=files.reduce((n,f)=>n+Buffer.byteLength(f.content),0);
  const each=Math.floor(byteBudget/Math.max(1,files.length));
  const result=files.map(f=>{
    if (Buffer.byteLength(JSON.stringify(f))<=each) return {...f,complete:true};
    const lines=f.content.split("\n"), chosen=new Set<number>();
    const add=(at:number,radius:number)=>{for(let i=Math.max(0,at-radius);i<=Math.min(lines.length-1,at+radius);i++)chosen.add(i);};
    // Imports, exact invariant sites and scheduling/scoping branches precede unrelated implementation.
    const anchors=[0,...lines.flatMap((line,i)=>/TASK_SCOPE_VIOLATION|removeTimingDependency|dependencyStart|resolveTimingDependencies|requirementTiming|isSelfAnchor|startFrame <|PROVIDER_SCHEMA_INVALID|MISSING_SEQUENTIAL_DEPENDENCY|REPAIR_SOURCE_SCOPE_VIOLATION|pendingAfter|temporalCues/.test(line)?[i]:[])];
    for(const at of anchors){
      const previous=new Set(chosen);add(at,at===0?18:12);
      if(Buffer.byteLength([...chosen].sort((a,b)=>a-b).map(i=>lines[i]).join("\n"))>each-1500){chosen.clear();previous.forEach(i=>chosen.add(i));break;}
    }
    const spans:{startLine:number;endLine:number;content:string}[]=[];
    for(const i of [...chosen].sort((a,b)=>a-b)){
      const last=spans.at(-1);
      if(last&&last.endLine===i){last.endLine=i+1;last.content+='\n'+lines[i];}
      else spans.push({startLine:i+1,endLine:i+1,content:lines[i]});
    }
    return {path:f.path,hash:f.hash,complete:false,totalLines:lines.length,spans};
  });
  const transmittedBytes=Buffer.byteLength(JSON.stringify(result));
  if(transmittedBytes>byteBudget)throw new Error(`CODE_REPAIR_CONTEXT_BUDGET: source spans ${transmittedBytes} exceed ${byteBudget}`);
  return {files:result,metrics:{originalBytes,transmittedBytes,sourceBudget:byteBudget,completeFiles:result.filter(f=>f.complete).length}};
}
