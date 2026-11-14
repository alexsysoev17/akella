import {z} from 'zod';
import {isDeepStrictEqual} from 'node:util';
import {Resvg} from '@resvg/resvg-js';

const id=z.string().min(1).max(100).regex(/^[\w:.-]+$/);
const color=z.string().regex(/^#[0-9a-fA-F]{6}$/);
const point=z.object({x:z.number().min(0).max(1),y:z.number().min(0).max(1)}).strict();
/** Optional on persisted v1 documents: omission retains the original solid rendering. */
export const appearanceSchema=z.object({
  fill:z.object({type:z.enum(['linear','radial']),
    from:point.describe('Linear gradient start; radial gradient center. Normalized to the layer box.'),
    to:point.describe('Linear gradient end. Ignored for radial gradients; set equal to from. This is NOT a radial focal point.'),
    radius:z.number().min(.001).max(3).describe('Radial extent in normalized layer-box coordinates, producing an ellipse on a non-square layer. Ignored for linear gradients.'),
    stops:z.array(z.object({offset:z.number().min(0).max(1),color,opacity:z.number().min(0).max(1)}).strict()).min(2).max(8)}).strict().nullable(),
  stroke:z.object({color,width:z.number().min(0).max(128),opacity:z.number().min(0).max(1)}).strict().nullable(),
  shadow:z.object({color,opacity:z.number().min(0).max(1),blur:z.number().min(0).max(128),
    offsetX:z.number().min(-512).max(512),offsetY:z.number().min(-512).max(512)}).strict().nullable(),
  blur:z.number().min(0).max(128),imageFit:z.enum(['contain','cover']),imagePosition:point,
  letterSpacing:z.number().min(-20).max(100),
  path:z.object({data:z.string().min(1).max(12000).regex(/^[Mm][MmZzLlHhVvCcSsQqTtAa0-9eE+.,\s-]*$/),
    width:z.number().positive().max(8192),height:z.number().positive().max(8192)}).strict().nullable(),
}).strict();
export type Appearance=z.infer<typeof appearanceSchema>;
export const defaultAppearance:Appearance={fill:null,stroke:null,shadow:null,blur:0,imageFit:'contain',imagePosition:{x:.5,y:.5},letterSpacing:0,path:null};
export const layerSchema=z.object({
  id, name:z.string().max(160), kind:z.enum(['text','image','logo','shape']),
  role:z.enum(['headline','offer','support','legal','hero','decoration','logo','panel']),
  x:z.number().min(-4096).max(8192), y:z.number().min(-4096).max(8192),
  width:z.number().positive().max(8192), height:z.number().positive().max(8192),
  rotation:z.number().min(-180).max(180), opacity:z.number().min(0).max(1),
  text:z.string().max(2000), assetId:z.string().max(100), fontId:z.string().max(100),
  fontSize:z.number().min(8).max(1200), lineHeight:z.number().min(.8).max(2),
  color, align:z.enum(['left','center','right']), shape:z.enum(['rect','ellipse','path']),
  radius:z.number().min(0).max(4096),
  appearance:appearanceSchema.nullable().optional(),
}).strict();
export const variantSchema=z.object({
  id, name:z.string().min(1).max(160), rationale:z.string().max(3000),
  width:z.number().int().min(120).max(4096),height:z.number().int().min(120).max(4096),
  background:color,layers:z.array(layerSchema).min(2).max(50),sourceIds:z.array(z.string()).max(30),
}).strict();
export const planSchema=z.object({
  message:z.string().max(3000),variants:z.array(variantSchema).min(1).max(12),
  generatedAssets:z.array(z.object({id,name:z.string().max(160),prompt:z.string().min(10).max(4000),
    referenceIds:z.array(z.string()).min(1).max(4),style:z.enum(['photo','3d','illustration']),background:z.enum(['cutout','scene'])}).strict()).max(4),
}).strict();
export const intentSchema=z.object({title:z.string().max(120),count:z.number().int().min(1).max(12),
  audience:z.enum(['consumer','employee','unspecified']),
  assetQueries:z.array(z.string().min(1).max(300)).min(1).max(4),referenceQuery:z.string().max(500)}).strict();
export const reviewSchema=z.object({summary:z.string().max(3000),issues:z.array(z.object({variantId:id,layerId:z.string(),
  severity:z.enum(['error','suggestion']),message:z.string().max(700)}).strict()).max(30)}).strict();
export type Layer=z.infer<typeof layerSchema>;
export type Variant=z.infer<typeof variantSchema>;
export type Plan=z.infer<typeof planSchema>;
export type Review=z.infer<typeof reviewSchema>;
/** Persisted v1 may omit appearance. The strict provider must emit it explicitly as null. */
export function bannerProviderSchema(schema:z.ZodType){
  const wire=z.toJSONSchema(schema);
  const visit=(value:any):void=>{
    if(!value||typeof value!=='object')return;
    if(value.type==='object'&&value.properties){
      const required=new Set(value.required??[]);
      for(const [key,property] of Object.entries<any>(value.properties))if(!required.has(key)){
        if(key!=='appearance'||!property.anyOf?.some((branch:any)=>branch.type==='null'))throw Error('Unsupported optional banner provider property: '+key);
        required.add(key);
      }
      value.required=[...required];
    }
    for(const child of Object.values(value))if(Array.isArray(child))child.forEach(visit);else visit(child);
  };
  visit(wire);return wire;
}
export const editIntentSchema=z.object({needsAssets:z.boolean(),assetQueries:z.array(z.string().min(1).max(300)).max(4),referenceQuery:z.string().max(500)}).strict();
export const editSchema=z.object({message:z.string().max(3000),patches:z.array(z.object({layerId:id,
  property:z.enum(['text','assetId','x','y','width','height','rotation','opacity','fontId','fontSize','lineHeight','color','align','radius','background','name','rationale','appearance']),
  value:z.union([z.string().max(2000),z.number(),appearanceSchema,z.null()])}).strict()).max(80),addLayers:z.array(layerSchema).max(20),removeLayerIds:z.array(id).max(20),
  generatedAssets:planSchema.shape.generatedAssets}).strict();
export function applyEdits(original:Variant,edits:z.infer<typeof editSchema>):Variant{
  const v=structuredClone(original);
  for(const id of edits.removeLayerIds){if(!v.layers.some(l=>l.id===id))throw Error('Неизвестный слой '+id);v.layers=v.layers.filter(l=>l.id!==id);}
  for(const p of edits.patches){
    if(p.layerId==='canvas'&&['background','name','rationale'].includes(p.property)){(v as any)[p.property]=p.value;continue;}
    const l=v.layers.find(l=>l.id===p.layerId);if(!l||['background','rationale'].includes(p.property))throw Error('Неизвестный слой или свойство');
    (l as any)[p.property]=p.value;
    // Opt a legacy image into clipping only when the user explicitly edits its radius.
    if(p.property==='radius'&&l.kind==='image'&&!l.appearance)l.appearance=structuredClone(defaultAppearance);
  }
  for(const l of edits.addLayers){if(v.layers.some(x=>x.id===l.id))throw Error('ID слоя уже существует');v.layers.push(l);}
  return variantSchema.parse(v);
}
export interface Resource {id:string;kind:'image'|'logo'|'font';name:string;file:string;sha256:string;
  width?:number;height?:number;family?:string;style?:string;clearspaceRatio?:number;
  clearspace?:{top:number;right:number;bottom:number;left:number};source?:unknown;logoRole?:'primary'|'partner';sheetLabel?:string;}

/** Ratios are relative to original mark height, measured from its SVG box.
 * Explicit source fields can be asymmetric (e.g. baseline-based lower clearance).
 */
export function logoClearspace(r:Resource,height:number){
  return Object.fromEntries((['top','right','bottom','left'] as const).map(side=>[side,height*(r.clearspace?.[side]??r.clearspaceRatio??0)])) as Record<'top'|'right'|'bottom'|'left',number>;
}
export interface BannerProject {version:1;id:string;brand:string;brandSnapshot:string;title:string;brief:string;
  revision:number;parentRevision?:number|null;variants:Variant[];resources:Resource[];messages:{role:'user'|'assistant';text:string;at:string}[];
  updatedAt:string;review?:Review;job?:{id:string;status:'running'|'completed'|'failed';stage:string;error?:string};}

/** Resizing changes layout only, with one-to-one layer identity. No regeneration. */
export function assertResize(original:Variant,resized:Variant){
  if(original.layers.length!==resized.layers.length)throw Error('Ресайз изменил набор объектов');
  const by=new Map(original.layers.map(l=>[l.id,l]));
  if(new Set(resized.layers.map(l=>l.id)).size!==by.size)throw Error('Повторяющиеся объекты ресайза');
  for(const l of resized.layers){const old=by.get(l.id);if(!old)throw Error('Ресайз создал новый объект');
    for(const key of ['kind','role','text','assetId','fontId','color','shape','opacity'] as const)
      if(l[key]!==old[key])throw Error(`Ресайз изменил содержимое ${l.id}: ${key}`);
    if(!isDeepStrictEqual(appearanceIdentity(l.appearance),appearanceIdentity(old.appearance)))
      throw Error(`Ресайз изменил оформление ${l.id}`);
  }
  if(original.background!==resized.background)throw Error('Ресайз изменил фон');
}
/** Paint/path identity is semantic. Gradient geometry, effect sizes, tracking and crop placement may reflow. */
function appearanceIdentity(value:Appearance|null|undefined){
  const a=value??defaultAppearance;
  return {fill:a.fill?{type:a.fill.type,stops:a.fill.stops}:null,path:a.path,imageFit:a.imageFit,
    stroke:a.stroke?{color:a.stroke.color,opacity:a.stroke.opacity}:null,
    shadow:a.shadow?{color:a.shadow.color,opacity:a.shadow.opacity}:null,
    hasBlur:a.blur>0};
}
function contentBounds(l:Layer,r?:Resource){
  let x=l.x,y=l.y,width=l.width,height=l.height;
  if(l.kind==='shape'&&l.shape==='path'&&l.appearance?.path){
    const p=l.appearance.path,stroke=l.appearance.stroke;
    const data=p.data.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
    // The authored viewport can be much larger than its contour. Measure real vector bounds.
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${l.width}" height="${l.height}"><g transform="rotate(${l.rotation} ${x+width/2} ${y+height/2})"><svg x="${x}" y="${y}" width="${width}" height="${height}" viewBox="0 0 ${p.width} ${p.height}" preserveAspectRatio="none" overflow="visible"><path d="${data}" fill="black"${stroke?` stroke="black" stroke-width="${stroke.width}" vector-effect="non-scaling-stroke"`:''}/></svg></g></svg>`;
    try{const b=new Resvg(svg).getBBox();return b?{x:b.x,y:b.y,width:b.width,height:b.height}:{x,y,width:0,height:0};}
    catch{/* Invalid contour is reported by rendering; retain conservative bounds here. */}
  }
  if(l.kind==='image'&&(l.appearance?.imageFit??'contain')==='contain'&&r?.width&&r.height){
    const scale=Math.min(width/r.width,height/r.height),w=r.width*scale,h=r.height*scale;
    x+=(width-w)*(l.appearance?.imagePosition.x??.5);y+=(height-h)*(l.appearance?.imagePosition.y??.5);width=w;height=h;
  }
  if(!l.rotation)return {x,y,width,height};
  const angle=l.rotation*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),cx=l.x+l.width/2,cy=l.y+l.height/2;
  const corners=[[x,y],[x+width,y],[x,y+height],[x+width,y+height]].map(([px,py])=>({x:cx+(px-cx)*c-(py-cy)*s,y:cy+(px-cx)*s+(py-cy)*c}));
  const left=Math.min(...corners.map(p=>p.x)),top=Math.min(...corners.map(p=>p.y));
  return {x:left,y:top,width:Math.max(...corners.map(p=>p.x))-left,height:Math.max(...corners.map(p=>p.y))-top};
}
export function validateDesign(v:Variant,resources:Resource[]){
  const issues:string[]=[],ids=new Set<string>();
  const res=new Map(resources.map(r=>[r.id,r]));
  if(v.width*v.height>10_000_000)issues.push('Холст превышает 10 мегапикселей');
  if(v.layers.filter(l=>l.kind==='logo'&&res.get(l.assetId)?.logoRole!=='partner').length!==1)issues.push('Нужен один оригинальный основной логотип бренда');
  for(const l of v.layers){
    if(ids.has(l.id))issues.push('Повторяющийся ID '+l.id);ids.add(l.id);
    if(l.kind==='text'&&(!l.text.trim()||res.get(l.fontId)?.kind!=='font'))issues.push(l.id+': текст или шрифт отсутствует');
    if(['image','logo'].includes(l.kind)&&res.get(l.assetId)?.kind!==l.kind.replace('image','image'))issues.push(l.id+': неизвестный ассет');
    if(l.kind==='shape'&&l.shape==='path'&&!l.appearance?.path)issues.push(l.id+': отсутствует векторный контур');
    if(l.appearance?.fill&&l.appearance.fill.stops.some((s,i,all)=>i>0&&s.offset<all[i-1].offset))issues.push(l.id+': точки градиента должны идти по порядку');
    const fill=l.appearance?.fill;
    if(fill?.type==='linear'&&fill.from.x===fill.to.x&&fill.from.y===fill.to.y)issues.push(l.id+': начало и конец линейного градиента совпадают');
    if(l.appearance?.path&&(l.kind!=='shape'||l.shape!=='path'))issues.push(l.id+': контур требует shape=path');
    if(l.appearance?.path?.data.match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g)?.some(n=>!Number.isFinite(Number(n))))issues.push(l.id+': нечисловые координаты контура');
    if((l.kind==='text'||l.kind==='logo')&&(l.x<0||l.y<0||l.x+l.width>v.width+.01||l.y+l.height>v.height+.01))issues.push(l.id+': выходит за холст');
    if(l.kind==='logo'){
      const r=res.get(l.assetId);if(!r?.width||!r.height)continue;
      if(Math.abs(l.width/l.height-r.width/r.height)>.03)issues.push(l.id+': нарушены пропорции логотипа');
      if(l.rotation!==0||l.opacity!==1)issues.push(l.id+': логотип должен сохранять исходный вид');
      if(l.appearance?.imageFit==='cover'||l.radius>0||l.appearance?.blur||l.appearance?.shadow)issues.push(l.id+': логотип не должен обрезаться или размываться');
      const gap=logoClearspace(r,l.height);
      if(l.x+.5<gap.left||l.y+.5<gap.top||v.width-l.x-l.width+.5<gap.right||v.height-l.y-l.height+.5<gap.bottom)issues.push(l.id+': охранное поле выходит за край');
      const logoIndex=v.layers.indexOf(l);
      // A source badge is a quiet surface separating the mark from the scene behind it.
      // Its outer box is the same approximate clearance model used elsewhere here.
      const badgeIndex=v.layers.reduce((found,p,index)=>index<logoIndex&&p.kind==='shape'&&p.shape==='rect'&&p.role==='panel'&&
        p.opacity===1&&p.rotation===0&&!p.appearance?.blur&&(!p.appearance?.fill||p.appearance.fill.stops.every(s=>s.opacity===1))&&
        p.x<=l.x-gap.left+.5&&p.y<=l.y-gap.top+.5&&p.x+p.width>=l.x+l.width+gap.right-.5&&p.y+p.height>=l.y+l.height+gap.bottom-.5?index:found,-1);
      for(const other of v.layers){
        // A background behind the mark is legitimate; a foreground panel can still cover it.
        const index=v.layers.indexOf(other);
        const canvasSurface=other.kind==='shape'&&other.shape==='rect'&&other.rotation===0&&other.x<=0&&other.y<=0&&
          other.x+other.width>=v.width&&other.y+other.height>=v.height;
        if(other===l||other.opacity===0||index<badgeIndex||((other.role==='panel'||canvasSurface)&&index<logoIndex))continue;
        const b=contentBounds(other,res.get(other.assetId));
        if(b.width>0&&b.height>0&&b.x<l.x+l.width+gap.right&&b.x+b.width>l.x-gap.left&&b.y<l.y+l.height+gap.bottom&&b.y+b.height>l.y-gap.top)
          issues.push(`${other.id}: входит в охранное поле логотипа`);
      }
    }
  }
  return issues;
}
