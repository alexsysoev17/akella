/** Internal bridge. The host supplies its authorized MCP transport; no HTTP route or UI. */
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { createProject } from './importer.js';
import { loadProject } from './project.js';
import { inspectSource } from './source.js';
import { assertFigmaSource } from './figma-source.js';
import { relativePath, within } from './files.js';
import type { FigmaSourceLink } from './types.js';

export interface FigmaOrigin { fileKey: string; pageId: string; sectionId: string }
export interface FigmaPacket {
  version: 1; origin: FigmaOrigin & {pageName: string; sectionName: string}; frameId: string;
  texts: Record<string,string>;
  embedded: {token: string; prefix: string; length: number; mime: string}[];
  manifest: {path: string; bytes: number}[];
  report: Record<string, any>;
}
export function decodeFigmaPacket(wire: {encoding: string; data: string}): FigmaPacket {
  if (wire.encoding !== 'deflate-base64' || typeof wire.data !== 'string' || wire.data.length > 24*1024*1024)
    throw new Error('Invalid/oversized MCP packet');
  const p = JSON.parse(inflateSync(Buffer.from(wire.data,'base64'), {maxOutputLength: 16*1024*1024}).toString('utf8'));
  if (p.version !== 1 || !p.origin || !p.frameId || !p.texts || !Array.isArray(p.manifest) || !Array.isArray(p.embedded) || p.report?.errorCount !== 0)
    throw new Error('Incomplete Figma export packet');
  return p;
}
const hash = (b: Buffer) => createHash('sha1').update(b).digest('hex');

/** Raw source bytes are matched by Figma imageHash, not names, URL order, or dimensions. */
export async function assembleFigmaExport(options: {
  packets: FigmaPacket[]; frameIds: string[]; downloadsDirectory: string; outputDirectory: string;
}): Promise<{zipPath: string; sourceDirectory: string; link: FigmaSourceLink; bytes: number}> {
  const {packets,frameIds}=options;
  if (!packets.length || new Set(frameIds).size!==frameIds.length || packets.length!==frameIds.length)
    throw new Error('Incomplete/duplicate frame selection');
  const first=packets[0];
  if (packets.some(p=>JSON.stringify(p.origin)!==JSON.stringify(first.origin))) throw new Error('Mixed Figma sources');
  const raw: Buffer[]=[];
  for(const entry of await readdir(options.downloadsDirectory,{withFileTypes:true}))
    if(entry.isFile() && entry.name.startsWith('raw-')) raw.push(await readFile(path.join(options.downloadsDirectory,entry.name)));
  const byHash=new Map(raw.map(b=>[hash(b),b]));
  const files=new Map<string,Buffer>();
  const add=(name:string,b:Buffer)=>{
    relativePath(name,'Figma resource');
    if(files.has(name) && !files.get(name)!.equals(b)) throw new Error(`Conflicting Figma resource: ${name}`);
    files.set(name,b);
  };
  let project:any; const reports:any[]=[];
  for(let index=0;index<frameIds.length;index++){
    const matches=packets.filter(p=>p.frameId===frameIds[index]);
    if(matches.length!==1)throw new Error('Missing/duplicate frame packet');
    const p=matches[0], doc=JSON.parse(p.texts['scene.json']);
    if(doc.scenes?.length!==1 || doc.scenes[0].figmaNodeId!==p.frameId)throw new Error('Frame packet identity mismatch');
    if(!project)project={...doc,scenes:[],assets:[]};
    const scene=doc.scenes[0];scene.index=index;scene.layerOrder=index;project.scenes.push(scene);reports.push(p.report);
    for(const asset of doc.assets){
      const previous=project.assets.find((a:any)=>a.assetId===asset.assetId);
      if(previous && JSON.stringify(previous)!==JSON.stringify(asset))throw new Error('Conflicting asset descriptor');
      if(!previous)project.assets.push(asset);
      if(asset.kind==='image'){
        const b=byHash.get(asset.imageHash);
        if(!b || b.length!==asset.byteLength)throw new Error(`Missing original image: ${asset.imageHash}`);
        add(asset.path,b);
      }
    }
    for(const [name,template] of Object.entries(p.texts)){
      if(name==='scene.json'||name==='export-report.json')continue;
      let text=template;
      for(const embed of p.embedded){
        if(!text.includes(embed.token))continue;
        const candidates=[...byHash.values()].map(b=>b.toString('base64')).filter(b=>b.length===embed.length&&b.startsWith(embed.prefix));
        if(candidates.length!==1)throw new Error(`Missing/ambiguous SVG image: ${name}`);
        text=text.split(embed.token).join(`${embed.mime};base64,${candidates[0]}`);
      }
      if(text.includes('__MCP_EMBED_'))throw new Error('Unresolved SVG image');
      add(name,Buffer.from(text));
    }
    relativePath(scene.preview,'Figma preview');
    add(scene.preview,await readFile(within(options.downloadsDirectory,`preview-${p.frameId.replace(':','-')}.png`)));
    for(const m of p.manifest){
      if(m.path==='scene.json'||m.path==='export-report.json')continue;
      if(files.get(m.path)?.length!==m.bytes)throw new Error(`Resource byte length mismatch: ${m.path} (expected ${m.bytes}, received ${files.get(m.path)?.length})`);
    }
  }
  const report={...reports[0],frames:packets.length,nodes:reports.reduce((n,r)=>n+r.nodes,0),images:project.assets.filter((a:any)=>a.kind==='image').length,svg:project.assets.filter((a:any)=>a.kind==='svg').length};
  for(const field of ['warnings','errors','unsupportedProperties','fallbackExports'])report[field]=reports.flatMap(r=>r[field]??[]);
  report.errorCount=report.errors.length;report.warningCount=report.warnings.length+report.unsupportedProperties.length;
  const link:FigmaSourceLink={version:1,...first.origin,fileUrl:`https://www.figma.com/design/${first.origin.fileKey}?node-id=${first.origin.sectionId.replace(':','-')}`,frameIds,capturedAt:new Date().toISOString(),transport:'figma-mcp'};
  assertFigmaSource(link,project);
  add('figma-source.json',Buffer.from(JSON.stringify(link,null,2)));
  add('scene.json',Buffer.from(JSON.stringify(project,null,2)));add('export-report.json',Buffer.from(JSON.stringify(report,null,2)));
  const bytes=[...files.values()].reduce((n,b)=>n+b.length,0);
  if(bytes>512*1024*1024)throw new Error('Export exceeds import limit');
  // Output must be a fresh directory: failed/repeated work cannot overwrite an export.
  await mkdir(options.outputDirectory,{recursive:false});
  const sourceDirectory=path.join(options.outputDirectory,'motion-project');
  const zip=new JSZip();
  for(const [name,b] of files){
    const dest=within(sourceDirectory,name);await mkdir(path.dirname(dest),{recursive:true});await writeFile(dest,b,{flag:'wx'});
    zip.file(`motion-project/${name}`,b);
  }
  await inspectSource(sourceDirectory);
  const zipPath=path.join(options.outputDirectory,'motion-project.zip');
  await writeFile(zipPath,await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}),{flag:'wx'});
  await writeFile(path.join(options.outputDirectory,'figma-source.json'),JSON.stringify(link,null,2),{flag:'wx'});
  return {zipPath,sourceDirectory,link,bytes};
}

export async function importFigmaExport(options: {source: string; link:FigmaSourceLink; name?:string; projectsRoot?:string; projectPath?:string}) {
  const old=options.projectPath?await loadProject(options.projectPath):undefined;
  if(!old && (!options.name||!options.projectsRoot))throw new Error('New Figma import needs name and projectsRoot');
  return createProject({source:options.source,figmaSource:options.link,name:old?.config.name??options.name!,projectsRoot:old?path.dirname(old.root):options.projectsRoot!,projectPath:old?.root,update:!!old,expectedFingerprint:old?.inspection.fingerprint,rejectInvalidMotionReferences:true});
}

/** Reading this is not a live sync; the returned identity is for the next explicit pull. */
export async function figmaRefreshSource(projectPath:string):Promise<FigmaSourceLink>{
  const p=await loadProject(projectPath);
  if(!p.config.figmaSource)throw new Error('Project is not linked to Figma');
  assertFigmaSource(p.config.figmaSource,p.inspection.document);
  return p.config.figmaSource;
}
