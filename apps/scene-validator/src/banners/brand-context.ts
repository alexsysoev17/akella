import {readFile,writeFile,copyFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {brandDirectory,searchBrandBatch,type BrandSearchRequest} from '../brands/library.js';
import {containedFile,hash} from './storage.js';
import type {Resource} from './contracts.js';
import {workspace} from './render.js';
import {renderIdentitySheet} from './identity-sheet.js';

export async function loadBrand(id:string){
  const base=brandDirectory(id),catalog=JSON.parse(await readFile(await containedFile(base,'catalog.json'),'utf8'));
  let profile:any;
  try{profile=JSON.parse(await readFile(await containedFile(base,catalog.authoring??'authoring.json'),'utf8'));}
  catch{throw Error('Для этого бренда ещё не подготовлены оригинальные логотипы и шрифты для макетов.');}
  if(profile.version!==1||profile.snapshot!==catalog.snapshot)throw Error('Профиль оформления бренда устарел');
  const records=JSON.parse(await readFile(await containedFile(base,catalog.records),'utf8')) as any[];
  for(const r of profile.resources as Resource[]){
    if(hash(await readFile(await containedFile(base,r.file)))!==r.sha256)throw Error('Изменился ресурс бренда: '+r.id);
  }
  return {base,catalog,profile,records};
}
export async function pinResource(directory:string,base:string,r:Resource):Promise<Resource>{
  const source=await containedFile(base,r.file),bytes=await readFile(source);
  if(hash(bytes)!==r.sha256)throw Error('Resource checksum mismatch');
  const ext=path.extname(source).toLowerCase();if(!['.png','.jpg','.jpeg','.webp','.svg','.ttf','.otf'].includes(ext))throw Error('Unsupported resource');
  const file='resources/'+r.sha256+ext;await mkdir(path.join(directory,'resources'),{recursive:true});await copyFile(source,path.join(directory,file));
  return {...r,file};
}
type ContextOptions={width?:number;height?:number;familyIds?:string[];audience?:string;persistContext?:boolean};
const unique=(records:any[])=>[...new Map(records.map(r=>[r.id,r])).values()];
function modelGeometry(value:any):any{
  const round=(v:any):any=>typeof v==='number'&&Number.isFinite(v)?Number(v.toFixed(4)):
    Array.isArray(v)?v.map(round):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,round(x)])):v;
  const geometry=round(value);
  if(Array.isArray(geometry.effects))geometry.effects=geometry.effects.filter((n:any)=>n.effectiveVisible!==false).flatMap((node:any)=>{
    if(!Array.isArray(node.effects))return [node];
    const effects=node.effects.filter((effect:any)=>effect.visible!==false).map((effect:any)=>{
      let fields:string[];
      if(['FOREGROUND_BLUR','BACKGROUND_BLUR'].includes(effect.type))fields=['type','radius','blurOpType','startOffset','endOffset','startRadius'];
      else if(['DROP_SHADOW','INNER_SHADOW'].includes(effect.type))fields=['type','offset','radius','spread','color','blendMode','showShadowBehindNode'];
      else return effect; // Unknown active effect types retain every parameter.
      return Object.fromEntries(fields.filter(k=>k in effect).map(k=>[k,effect[k]]));
    });
    return effects.length?[{nodeId:node.nodeId,...(node.blendMode&&node.blendMode!=='NORMAL'?{blendMode:node.blendMode}:{}),effects}]:[];
  });
  return {...geometry,approximation:{decimalPlaces:4,scope:'model view only; exact source geometry remains in the stored evidence'}};
}
/** Audit paths/hashes stay in the project; the model needs visual facts and stable IDs. */
export function modelBrandContext(context:any){
  // This is a projection for the prompt, never a mutation of pinned evidence or source geometry.
  context=structuredClone(context);
  const {resources:profileResources,...profile}=context.profile;
  const sectionKey=(design:any)=>JSON.stringify([design?.pageId,design?.sectionId]);
  const studies=new Map<string,any>(context.evidence.filter((r:any)=>r.design?.role==='composition-study').map((r:any)=>[sectionKey(r.design),r]));
  const packedIds=new Set((context.referenceRecipes??[]).map((r:any)=>r.referenceId));
  return {brand:context.brand,snapshot:context.snapshot,audience:context.audience,profile,assets:context.assets,
    evidence:context.evidence.map((r:any)=>{
      let design=r.design?{...r.design}:undefined,body=r.body,studyId:string|undefined;
      if(design)delete design.referencePack; // Selected recipes appear once below with actual available resource IDs.
      if(design&&packedIds.has(r.id)){
        // Resolved, reviewed anchors/materials below replace a broad authored subtree summary.
        // Keep the latter in pinned audit evidence, not as competing placement instructions.
        delete design.geometrySummary;
        design.geometrySource='referenceRecipes';
      }
      const study=studies.get(sectionKey(design));
      if(r.polarity==='negative'){
        // The exact warning and its scope survive; its surrounding positive style is not inspiration.
        if(design)design=Object.fromEntries(['pageId','sectionId','annotation','audience','usage','campaignId'].filter(k=>k in design).map(k=>[k,design[k]]));
      }else{
        if(design?.role==='advertisement'&&study){
          if(JSON.stringify(design.principles)===JSON.stringify(study.design.principles))delete design.principles;
          if(typeof study.body==='string'&&study.body&&typeof body==='string'&&body.startsWith(study.body)){
            body=body.slice(study.body.length).trim();studyId=study.id;
          }
        }
        if(design?.role==='composition-study'&&typeof body==='string'&&body&&Array.isArray(design.principles)&&design.principles.join(' ').includes(body))body=undefined;
        if(design?.geometrySummary)design.geometrySummary=modelGeometry(design.geometrySummary);
      }
      return {id:r.id,kind:r.kind,title:r.title,body,scope:r.scope,authority:r.authority,polarity:r.polarity,design,...(studyId?{studyId}:{}),
        source:r.evidence.map((e:any)=>({nodeId:e.nodeId,url:e.url,region:e.region}))};
    }),
    resources:context.resources.map(({source,file,sha256,...r}:any)=>r),
    referenceRecipes:(context.referenceRecipes??[]).map((pack:any)=>modelGeometry(pack)),
    retrievalMode:context.retrievalMode,imageOrder:context.imageOrder};
}
/** Actual compositions first; rule diagrams and asset sheets are not banner exemplars. */
export function chooseReferenceImages(records:any[],options:ContextOptions={},limit=6){
  const target=options.width&&options.height?options.width/options.height:1;
  const eligible=unique(records).filter(r=>r.status==='reviewed'&&r.kind==='example'&&r.polarity==='positive'&&
    !['key-visual-study','hero-reference','source-annotation','rule-diagram','asset-board'].includes(r.design?.role)&&r.evidence?.some((e:any)=>e.image));
  const distance=(r:any)=>r.design?.format?Math.abs(Math.log((r.design.format.width/r.design.format.height)/target)):2;
  const preferred=new Set(options.familyIds??[]);
  const groups=new Map<string,any[]>();
  for(const r of eligible){const key=r.design?.familyId??r.id;groups.set(key,[...(groups.get(key)??[]),r]);}
  // Search order is semantic. Format affinity chooses a member, never replaces the subject.
  const ordered=[...groups.entries()].sort(([a],[b])=>Number(preferred.has(b))-Number(preferred.has(a)));
  const selected:any[]=[],families=new Set<string>(),campaigns=new Set<string>();
  for(const [family,members] of ordered){const r=[...members].sort((a,b)=>distance(a)-distance(b))[0];
    const campaign=r.design?.campaignId??family;if(campaigns.has(campaign))continue;
    selected.push(r);families.add(family);campaigns.add(campaign);if(selected.length===Math.min(4,limit))break;}
  // A second aspect ratio from a selected family explains reflow instead of mere scale.
  for(const r of eligible){if(selected.includes(r)||!families.has(r.design?.familyId))continue;
    const siblings=selected.filter(s=>s.design?.familyId===r.design?.familyId);
    if(siblings.length!==1||!r.design?.format||!siblings[0].design?.format)continue;
    const a=r.design.format,b=siblings[0].design.format;
    if(Math.abs(Math.log(a.width/a.height/(b.width/b.height)))<.3)continue;
    selected.push(r);if(selected.length>=limit)break;
  }
  return selected.slice(0,limit);
}
/** A textual study is not enough to reconstruct a material. Resolve a bounded
 * concrete source from its section, and ready material siblings of chosen campaigns.
 */
export function groundReferenceStudies(selected:any[],records:any[],studies:any[],options:ContextOptions={},limit=10){
  const result=[...selected],ids=new Set(result.map(r=>r.id));
  const target=options.width&&options.height?options.width/options.height:1;
  const usable=records.filter(r=>r.kind==='example'&&r.status==='reviewed'&&r.polarity==='positive'&&
    r.design?.role==='advertisement'&&r.evidence?.some((e:any)=>e.image)&&(!options.audience||options.audience==='unspecified'||r.design.audience===options.audience));
  const rank=(a:any,b:any)=>Number(Boolean(b.design.referencePack))-Number(Boolean(a.design.referencePack))||
    Math.abs(Math.log((a.design.format?.ratio??1)/target))-Math.abs(Math.log((b.design.format?.ratio??1)/target));
  const add=(candidates:any[])=>{const r=candidates.filter(r=>!ids.has(r.id)).sort(rank)[0];if(r&&result.length<limit){result.push(r);ids.add(r.id);}};
  for(const ref of selected){
    if(ref.design?.referencePack||!ref.design?.campaignId||result.some(r=>r.design?.campaignId===ref.design.campaignId&&r.design.referencePack))continue;
    add(usable.filter(r=>r.design.pageId===ref.design.pageId&&r.design.campaignId===ref.design.campaignId&&r.design.referencePack));
  }
  for(const study of studies.slice(0,4)){
    if(!study.design?.sectionId||result.some(r=>r.design?.pageId===study.design.pageId&&r.design?.sectionId===study.design.sectionId))continue;
    add(usable.filter(r=>r.design.pageId===study.design.pageId&&r.design.sectionId===study.design.sectionId));
  }
  return result;
}
/** Exact reviewed source parts follow reference choice; broad semantic assets fill the remaining slots. */
export function selectReferenceAssets(references:any[],records:any[],assetHits:any[],limit=24){
  const eligible=(r:any)=>r?.kind==='asset'&&r.status==='reviewed'&&r.polarity==='positive'&&r.media?.sha256&&r.design?.use!=='referenceOnly';
  const byId=new Map(records.filter(eligible).map(r=>[r.id,r]));
  const packs=references.filter(r=>r.design?.referencePack?.version===1).map(r=>({referenceId:r.id,...structuredClone(r.design.referencePack)}));
  const replacementHashes=new Set<string>(packs.flatMap(p=>p.assetUses.filter((u:any)=>u.policy==='replace-with-brief').map((u:any)=>byId.get(u.assetId)?.media.sha256).filter(Boolean)));
  const preserveHashes=new Set<string>(packs.flatMap(p=>p.assetUses.filter((u:any)=>u.policy==='preserve').map((u:any)=>byId.get(u.assetId)?.media.sha256).filter(Boolean)));
  const queryHits=assetHits.filter(r=>eligible(r)&&(!replacementHashes.has(r.media.sha256)||preserveHashes.has(r.media.sha256)));
  const selected:any[]=[],byHash=new Map<string,any>(),linked=new Set<string>();
  const add=(r:any,fromPack=false)=>{const prior=byHash.get(r.media.sha256);if(prior){if(fromPack)linked.add(prior.id);return prior;}
    if(selected.length>=limit)return undefined;selected.push(r);byHash.set(r.media.sha256,r);if(fromPack)linked.add(r.id);return r;};
  const rolePriority:any={background:0,material:1,decor:2,'hero-reference':3};
  const lists=packs.map(p=>p.assetUses.filter((u:any)=>['preserve','match-brief'].includes(u.policy)).sort((a:any,b:any)=>(rolePriority[a.role]??4)-(rolePriority[b.role]??4)));
  // Preserve capacity for the brief's actual product; a reference's historic KV is not an offer fact.
  const packLimit=Math.max(0,limit-Math.min(8,queryHits.length));
  for(let i=0;i<16;i++)for(const list of lists){const use=list[i],asset=use&&byId.get(use.assetId);if(asset&&(selected.length<packLimit||byHash.has(asset.media.sha256)))add(asset,true);}
  for(const asset of queryHits)add(asset);
  // If query hits deduplicate, remaining capacity still belongs to approved reference parts.
  for(const list of lists)for(const use of list){const asset=byId.get(use.assetId);if(asset)add(asset,true);}
  const recipes=packs.map(p=>({...p,assetUses:p.assetUses.map((use:any)=>{
    const asset=byId.get(use.assetId),pin=['preserve','match-brief'].includes(use.policy)&&asset&&byHash.get(asset.media.sha256);
    return {...use,...(pin?{assetId:pin.id,...(pin.id!==use.assetId?{sourceAssetId:use.assetId}:{})}:{}),available:Boolean(pin),...(use.policy==='match-brief'?{requiresBriefMatch:true}:{})};
  }),omittedAssetIds:p.assetUses.filter((use:any)=>{const asset=byId.get(use.assetId);return ['preserve','match-brief'].includes(use.policy)&&(!asset||!byHash.has(asset.media.sha256));}).map((use:any)=>use.assetId)}));
  return {candidates:selected,recipes,preserveOriginalIds:linked};
}
export async function pinnedReferenceImages(directory:string,context:any){
  const images:string[]=[];
  for(const r of context.referenceImages??[]){const file=await containedFile(directory,r.file);if(hash(await readFile(file))!==r.sha256)throw Error('Сохранённый визуальный пример изменился');images.push(file);}
  return images;
}
export async function prepareBrandContext(id:string,queries:string[],referenceQuery:string,directory:string,options:ContextOptions={}){
  const brand=await loadBrand(id);
  const query=referenceQuery.trim()||queries.join(' ').trim()||'композиция и правила логотипа';
  const assetQueries=[...new Set(queries.map(q=>q.trim()).filter(Boolean))].slice(0,4);
  const pages:string[]=(brand.profile.referencePageIds??[]).slice(0,2);
  const audience=options.audience&&options.audience!=='unspecified'?options.audience:brand.profile.referenceAudience;
  const requests:BrandSearchRequest[]=assetQueries.map(query=>({query,kind:'asset',limit:8,filters:{polarity:'positive'}}));
  requests.push({query,kinds:['rule','editorial','composition','measurement'],limit:8});
  const referenceStart=requests.length;
  for(const pageId of pages.length?pages:[undefined])requests.push({query,kind:'example',limit:8,
    filters:{polarity:'positive',...(pageId?{pageId}:{}),...(audience?{audience}:{})},diversifyFamilies:true,
    ...(options.width&&options.height?{targetFormat:{width:options.width,height:options.height}}:{})});
  if(options.familyIds?.length&&requests.length<8)requests.push({query,kind:'example',limit:8,
    filters:{familyId:options.familyIds[0],polarity:'positive',...(audience?{audience}:{})},
    ...(options.width&&options.height?{targetFormat:{width:options.width,height:options.height}}:{})});
  const results=await searchBrandBatch(id,requests);
  const assetHits=unique(results.slice(0,assetQueries.length).flatMap(r=>r.results).filter(r=>r.kind==='asset'&&r.status==='reviewed'&&r.polarity==='positive'&&r.design?.use!=='referenceOnly'));
  const byImage=new Map<string,any>();
  for(const r of assetHits){const key=r.media.sha256,prior=byImage.get(key);if(!prior||(!prior.design?.pageId&&pages.includes(r.design?.pageId)))byImage.set(key,r);}
  const referenceResults=results.slice(referenceStart);
  const referencePool=unique(referenceResults.flatMap(r=>[...r.results,...r.related])).filter(r=>(!pages.length||pages.includes(r.design?.pageId))&&(!audience||r.design?.audience===audience));
  const rules=results[assetQueries.length];
  const relevantStudy=(r:any)=>r.kind!=='composition'||(!r.design?.audience||!audience||r.design.audience===audience);
  const studies=unique([...rules.results,...rules.related,...referenceResults.flatMap(r=>r.related)]).filter(r=>r.kind==='composition'&&r.design?.role==='composition-study'&&relevantStudy(r));
  const references=groundReferenceStudies(chooseReferenceImages(referencePool,options),brand.records,studies,{...options,audience});
  const {candidates,recipes,preserveOriginalIds}=selectReferenceAssets(references,brand.records,[...byImage.values()]);
  const visualRules:any[]=(brand.profile.visualEvidence??[]).map((id:string)=>brand.records.find(r=>r.id===id)).filter((r:any)=>r?.status==='reviewed'&&r.evidence?.some((e:any)=>e.image)).slice(0,4);
  const evidence=unique([...brand.records.filter(r=>brand.profile.requiredEvidence.includes(r.id)),...visualRules,...references,
    ...referenceResults.flatMap(r=>r.related.filter((x:any)=>x.polarity==='negative')),
    ...referenceResults.flatMap(r=>r.related.filter((x:any)=>x.kind==='composition'&&relevantStudy(x))),
    ...rules.related.filter((r:any)=>r.polarity==='negative'),...rules.results.filter(relevantStudy),...rules.required,
    ...referenceResults.flatMap(r=>r.required)]).filter(r=>r.kind!=='asset'&&r.status==='reviewed').slice(0,28);
  const resources:Resource[]=[];
  for(const r of brand.profile.resources as Resource[])resources.push(await pinResource(directory,brand.base,r));
  for(const r of candidates){resources.push(await pinResource(directory,brand.base,{id:r.id,kind:'image',name:r.title,
    file:r.media.file,sha256:r.media.sha256,width:r.media.width,height:r.media.height,source:{brand:id,snapshot:brand.catalog.snapshot,evidence:r.evidence,originalSha256:r.media.sha256,
      ...(preserveOriginalIds.has(r.id)?{preserveOriginalBounds:true}:{})}}));}
  // Tight transparent bounds are derived once, then pinned. Originals remain in the brand snapshot.
  await writeFile(path.join(directory,'asset-preparation.json'),JSON.stringify({resources}));
  await promisify(execFile)(path.join(workspace,'data/knowledge/.venv/bin/python'),[path.join(workspace,'scripts/knowledge/banner_assets.py'),directory],{timeout:30000,maxBuffer:100000});
  const prepared=JSON.parse(await readFile(path.join(directory,'prepared-resources.json'),'utf8')) as Resource[];
  const referenceImages:any[]=[];await mkdir(path.join(directory,'references'),{recursive:true});
  for(const r of [...visualRules,...references]){const original=await containedFile(brand.base,r.evidence.find((e:any)=>e.image).image),bytes=await readFile(original);
    const sha256=hash(bytes),file='references/'+sha256+path.extname(original);await copyFile(original,path.join(directory,file));
    referenceImages.push({id:r.id,kind:visualRules.includes(r)?'rule-diagram':r.kind,familyId:r.design?.familyId,file,sha256});}
  const specimen=await renderIdentitySheet(directory,prepared);if(specimen)referenceImages.unshift(specimen);
  const images=[path.join(directory,'asset-sheet.png'),...referenceImages.map(r=>path.join(directory,r.file))];
  const context={brand:id,snapshot:brand.catalog.snapshot,profile:brand.profile,audience,
    assets:candidates.map(r=>({id:r.id,sheetLabel:prepared.find(p=>p.id===r.id)?.sheetLabel,title:r.title,description:r.body,design:r.design})),
    evidence:evidence.map(r=>({id:r.id,kind:r.kind,title:r.title,body:r.body,scope:r.scope,authority:r.authority,polarity:r.polarity,evidence:r.evidence,design:r.design,geometry:r.geometry})),
    resources:prepared.map(({file,sha256,...r})=>r),referenceImages,referenceRecipes:recipes,retrievalMode:results.map(r=>r.mode),
    retrieval:results.map((r,i)=>({request:requests[i],diagnostics:r.diagnostics,selectedIds:r.results.map((x:any)=>x.id)})),
    imageOrder:['Candidate assets: A01, A02, … match assets/resources.sheetLabel; use the mapped exact id as assetId',...(specimen?['Original logo and typeface specimens on neutral backgrounds; usage determined by brand rules, NOT a composition reference']:[]),...visualRules.map(r=>'Rule diagram, NOT a banner template: '+r.id),...references.map(r=>r.id)]};
  if(options.persistContext!==false)await writeFile(path.join(directory,'brand-context.json'),JSON.stringify(context,null,2));
  return {context,resources:prepared,images,brand};
}
