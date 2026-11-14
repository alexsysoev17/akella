import {readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {Resvg} from '@resvg/resvg-js';
import type {Resource,Variant} from './contracts.js';
import {containedFile} from './storage.js';
import {workspace} from './workspace.js';
export {workspace} from './workspace.js';
export async function renderVariant(directory:string,v:Variant,resources:Resource[],output:string){
  const resolved=await Promise.all(resources.map(async r=>({...r,absoluteFile:await containedFile(directory,r.file)})));
  await writeFile(output+'.json',JSON.stringify({variant:v,resources:resolved}));
  const {stdout}=await promisify(execFile)(path.join(workspace,'data/knowledge/.venv/bin/python'),
    [path.join(workspace,'scripts/knowledge/banner_layout.py'),output+'.json'],{timeout:30000,maxBuffer:200000});
  const report=JSON.parse(stdout) as {issues:string[];textBoxes:unknown[];nativeFontFiles:string[]};
  const svg=await readFile(output+'.svg','utf8');
  const png=new Resvg(svg,{font:{fontFiles:report.nativeFontFiles,loadSystemFonts:false}}).render().asPng();
  await writeFile(output+'.png',png);return report;
}
