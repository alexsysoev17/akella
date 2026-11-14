// Read-only MCP programs shared by the application and development tooling.
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
let root = path.dirname(fileURLToPath(import.meta.url));
while (!existsSync(path.join(root, 'figma-motion-exporter/src/exporter/scene.ts'))) {
    const parent = path.dirname(root);
    if (parent === root)
        throw new Error('Canonical Figma exporter source not found');
    root = parent;
}
const require = createRequire(import.meta.url);
const inflate = require.resolve('pako/lib/inflate.js', { paths: [path.dirname(require.resolve('jszip'))] });
// JSZip's locked compressor is reused only by this build tool.
const deflate = require.resolve('pako/lib/deflate.js', { paths: [path.dirname(require.resolve('jszip'))] });
let cached: string | undefined;
export async function frameExportCode(origin: {
    fileKey: string;
    pageId: string;
    sectionId: string;
}, frameId: string, offset = 0, capturedAt = new Date().toISOString()) {
    if (!cached) {
        const result = await build({ stdin: { contents: `export {exportProject} from './figma-motion-exporter/src/exporter/scene.ts'; export {deflate} from ${JSON.stringify(deflate)};`, resolveDir: root, loader: 'ts' }, bundle: true, format: 'iife', globalName: 'MotionExporter', write: false, minify: true });
        cached = result.outputFiles[0].text;
    }
    const code = cached + `
const origin=${JSON.stringify(origin)};
await figma.setCurrentPageAsync(await figma.getNodeByIdAsync(origin.pageId));
const section=await figma.getNodeByIdAsync(origin.sectionId);
const frame=await figma.getNodeByIdAsync(${JSON.stringify(frameId)});
let owner=section;while(owner&&owner.type!=='PAGE')owner=owner.parent;
let ancestor=frame;while(ancestor&&ancestor.id!==section.id)ancestor=ancestor.parent;
if(owner?.id!==origin.pageId || !ancestor || frame.type!=='FRAME') throw new Error('Figma selection changed');
const texts={},embedded=[],manifest=[];
const report=await MotionExporter.exportProject([frame],async(path,data)=>{
manifest.push({path,bytes:typeof data==='string'?unescape(encodeURIComponent(data)).length:data.length});
if(typeof data==='string')texts[path]=data.replace(/data:image\\/[^;"']+;base64,([A-Za-z0-9+/=\\r\\n]+)/g,(match,b64)=>{const token='__MCP_EMBED_'+embedded.length+'__';embedded.push({token,prefix:b64.slice(0,100),length:b64.length,mime:match.slice(0,match.indexOf(';'))});return token;});
},()=>{});
if(report.errorCount) throw new Error(JSON.stringify(report.errors));
report.exportedAt=${JSON.stringify(capturedAt)};
if(texts['export-report.json']){const r=JSON.parse(texts['export-report.json']);r.exportedAt=report.exportedAt;texts['export-report.json']=JSON.stringify(r);}
const payload={version:1,origin:{...origin,pageName:figma.currentPage.name,sectionName:section.name},frameId:frame.id,texts,embedded,manifest,report};
const bytes=MotionExporter.deflate(JSON.stringify(payload));
const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';let data='';
for(let i=0;i<bytes.length;i+=3){const a=bytes[i],b=bytes[i+1],c=bytes[i+2];data+=chars[a>>2]+chars[((a&3)<<4)|((b||0)>>4)]+(i+1<bytes.length?chars[((b&15)<<2)|((c||0)>>6)]:'=')+(i+2<bytes.length?chars[c&63]:'=');}
let checksum=2166136261;for(let i=0;i<data.length;i++)checksum=Math.imul(checksum^data.charCodeAt(i),16777619)>>>0;
return {encoding:'deflate-base64-chunk',offset:${offset},total:data.length,checksum,data:data.slice(${offset},${offset}+42000)};`;
    if (code.length > 50000)
        throw new Error('MCP program exceeds 50KB');
    return code;
}
export function discoveryCode(origin: {
    fileKey: string;
    pageId: string;
    sectionId: string;
}) {
    return `await figma.setCurrentPageAsync(await figma.getNodeByIdAsync(${JSON.stringify(origin.pageId)}));
const section=await figma.getNodeByIdAsync(${JSON.stringify(origin.sectionId)});
let owner=section;while(owner&&owner.type!=='PAGE')owner=owner.parent;if(owner?.id!==figma.currentPage.id)throw new Error('Wrong source page');
function frames(n){if(n.type==='FRAME')return [n];return 'children' in n?n.children.flatMap(frames):[];}
return {pageName:figma.currentPage.name,sectionName:section.name,frames:frames(section).map(n=>({id:n.id,name:n.name,x:n.absoluteTransform[0][2],y:n.absoluteTransform[1][2]})).sort((a,b)=>a.x-b.x||a.y-b.y)};`;
}
let cachedPng: string | undefined;
export async function previewSignatureCode(pageId: string, frameId: string) {
    if (!cachedPng) {
        const result = await build({ stdin: { contents: `export {inflate} from ${JSON.stringify(inflate)}; export {pngPixels} from './apps/scene-validator/src/figma-png.ts';`, resolveDir: root, loader: 'ts' }, bundle: true, format: 'iife', globalName: 'Preview', write: false, minify: true });
        cachedPng = result.outputFiles[0].text;
    }
    return cachedPng + `await figma.setCurrentPageAsync(await figma.getNodeByIdAsync(${JSON.stringify(pageId)}));const frame=await figma.getNodeByIdAsync(${JSON.stringify(frameId)});const bytes=await frame.exportAsync({format:'PNG',constraint:{type:'SCALE',value:1}});return Preview.pngPixels(bytes,Preview.inflate);`;
}
