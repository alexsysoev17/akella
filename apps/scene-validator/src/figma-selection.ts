import { figmaResult } from './figma-connection.js';
import type { FigmaMcpTransport } from './figma-runner.js';

export type Named = {name:string};
export type FigmaFile = Named & {fileKey:string};
export type Candidate = Named & {id:string;type:string;frameIds:string[];pageId:string;pageName:string;parentId?:string};
const normalize=(text:string)=>text.toLowerCase().normalize('NFKC').replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').replace(/(\p{L})(\d)/gu,'$1 $2').trim();
function mentioned(name:string,text:string){const n=normalize(name);return n && (` ${normalize(text)} `).includes(` ${n} `);}
export function matching<T extends Named>(items:T[],requests:string[]):T[]{
  for(const request of [...requests].reverse()){
    // URL slugs and query parameters are context, not explicit object names.
    const text=request.replace(/https?:\/\/[^\s«»"<>]+/g,'');
    const found=items.filter(x=>mentioned(x.name,text));
    if(found.length){const longest=Math.max(...found.map(x=>normalize(x.name).length));return found.filter(x=>normalize(x.name).length===longest);}
  }
  return [];
}
export function requestedFile(requests:string[],catalog:FigmaFile[]):FigmaFile & {nodeId?:string}{
  for(const request of [...requests].reverse()){
    const urls=[...request.matchAll(/https?:\/\/(?:www\.)?figma\.com\/(?:design|file)\/[^\s«»"<>]+/g)];
    if(urls.length){
      const url=new URL(urls.at(-1)![0]),parts=url.pathname.split('/'),fileKey=parts[2];
      if(!/^[a-zA-Z0-9]+$/.test(fileKey))throw new Error('Не удалось прочитать ссылку Figma.');
      const nodeId=url.searchParams.get('node-id')?.replace('-',':');
      return {fileKey,name:catalog.find(x=>x.fileKey===fileKey)?.name??decodeURIComponent(parts[3]||fileKey).replace(/-$/,''),nodeId:nodeId&&/^\d+:\d+$/.test(nodeId)?nodeId:undefined};
    }
    const matches=matching(catalog,[request]);
    if(matches.length===1)return matches[0];
    if(matches.length>1)throw new Error(`Нашёл несколько файлов: ${matches.map(x=>`«${x.name}»`).join(', ')}. Какой открыть?`);
  }
  if(catalog.length===1)return catalog[0];
  throw new Error(catalog.length?`Какой файл открыть: ${catalog.map(x=>`«${x.name}»`).join(', ')}? Можно прислать ссылку.`:'Пришли ссылку на файл или нужные кадры в Figma.');
}
export function chooseFrames(candidates:Candidate[],requests:string[],linked?:Candidate):Candidate{
  // Explicit object names can narrow a link to a page or section.
  const named=matching(candidates.filter(c=>c.type!=='PAGE'),requests);
  if(named.length===1)return named[0];
  if(named.length>1)throw new Error(`Нашёл несколько вариантов: ${named.map(x=>`«${x.name}» (${x.pageName})`).join(', ')}. Какой взять?`);
  if(linked?.frameIds.length)return linked;
  const groups=candidates.filter(c=>c.type!=='FRAME'&&c.type!=='PAGE');
  // A single outer storyboard includes its nested groups, rather than asking about each group.
  const hasParentGroup=(c:Candidate)=>{let id=c.parentId;while(id){if(groups.some(p=>p.id===id))return true;id=candidates.find(p=>p.id===id)?.parentId;}return false;};
  const outer=groups.filter(c=>!hasParentGroup(c)&&!groups.some(p=>p!==c&&p.frameIds.length>c.frameIds.length&&c.frameIds.every(id=>p.frameIds.includes(id))));
  if(outer.length===1)return outer[0];
  const pages=candidates.filter(c=>c.type==='PAGE'&&c.frameIds.length);
  if(!outer.length&&pages.length===1)return pages[0];
  if(!pages.length)throw new Error('В файле не нашёл кадров для импорта. Пришли ссылку на нужный кадр.');
  const options=outer.length?outer:pages;
  throw new Error(`Нашёл несколько раскадровок: ${options.map(x=>`«${x.name}» (${x.pageName})`).join(', ')}. Какую взять?`);
}
/** Reads only outer frames and structural containers; never mistakes frame internals for scenes. */
export function pageInventoryCode(pageId:string,nodeId?:string,offset=0){return `
await figma.setCurrentPageAsync(await figma.getNodeByIdAsync(${JSON.stringify(pageId)}));
const page=figma.currentPage,items=[];
const sort=frames=>frames.sort((a,b)=>a.absoluteTransform[0][2]-b.absoluteTransform[0][2]||a.absoluteTransform[1][2]-b.absoluteTransform[1][2]);
function outer(node){if(node.type==='FRAME')return [node];if(!('children' in node))return [];return node.children.flatMap(outer);}
function item(node){return {id:node.id,name:node.name,type:node.type,parentId:node.parent?.id,pageId:page.id,pageName:page.name,frameIds:sort(outer(node)).map(f=>f.id)};}
function visit(node){const value=item(node);if(value.frameIds.length)items.push(value);if(node.type!=='FRAME'&&'children' in node)for(const c of node.children)if(['FRAME','SECTION','GROUP'].includes(c.type))visit(c);}
visit(page);
let linked=null;
if(${JSON.stringify(nodeId??null)}){let node=await figma.getNodeByIdAsync(${JSON.stringify(nodeId??null)});let ancestor=node;while(ancestor&&ancestor.type!=='PAGE')ancestor=ancestor.parent;if(ancestor&&ancestor.id===page.id){while(node&&!['PAGE','SECTION','GROUP','FRAME'].includes(node.type))node=node.parent;if(node)linked=item(node);}}
const offset=${offset};let end=Math.min(items.length,offset+100);let reply;
do{reply={items:items.slice(offset,end),linked:offset===0?linked:null,nextOffset:end<items.length?end:null};if(unescape(encodeURIComponent(JSON.stringify(reply))).length<40000)break;end--;}while(end>offset);
if(end===offset&&items.length>offset)throw new Error('Figma selection metadata exceeds response limit');return reply;`;
}
export async function resolveFrames(client:FigmaMcpTransport,file:FigmaFile & {nodeId?:string},requests:string[]){
  const session=figmaResult(await client.call('create_session',{fileKey:file.fileKey,description:'Find requested frames in Akella'}));
  const args={fileKey:file.fileKey,sessionId:session.sessionId,skillNames:'figma-use'};
  const meta=figmaResult(await client.call('use_figma',{...args,description:'Find pages and linked object location',code:`const id=${JSON.stringify(file.nodeId??null)};let linkedPageId=null;if(id){let n=await figma.getNodeByIdAsync(id);while(n&&n.type!=='PAGE')n=n.parent;linkedPageId=n?.id??null;}return {pages:figma.root.children.map(p=>({id:p.id,name:p.name})),linkedPageId};`}));
  const namedPages=matching<{id:string;name:string}>(meta.pages,requests);
  const pages=namedPages.length?namedPages:meta.linkedPageId?meta.pages.filter((p:any)=>p.id===meta.linkedPageId):meta.pages;
  const inventories=await Promise.all(pages.map(async(page:{id:string;name:string})=>{
    let offset=0;const items:Candidate[]=[];let linked:Candidate|undefined;
    do{const response=figmaResult(await client.call('use_figma',{...args,description:`Find frames on ${page.name}`,code:pageInventoryCode(page.id,file.nodeId,offset)}));items.push(...response.items);if(response.linked)linked=response.linked;offset=response.nextOffset;}while(offset!==null);
    return {items,linked};
  }));
  const candidates:Candidate[]=inventories.flatMap((x:any)=>x.items);
  const linked:Candidate|undefined=inventories.find((x:any)=>x.linked)?.linked;
  if(file.nodeId&&!linked)throw new Error('Объект из ссылки не найден на выбранных страницах. Проверь ссылку или укажи другую раскадровку.');
  // A section/frame link restricts name lookup to its own subtree, but a page link doesn't.
  const scope=linked&&linked.type!=='PAGE'?candidates.filter(c=>c.frameIds.every(id=>linked.frameIds.includes(id))):candidates;
  return chooseFrames(scope,requests,linked);
}
