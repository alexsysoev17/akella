import {z} from 'zod';
import {planSchema,reviewSchema,type Variant} from './contracts.js';

/** A communication plan precedes placement. It is trace evidence, not a beauty score. */
export const artDirectionSchema=z.object({
  message:planSchema.shape.message,
  directions:z.array(z.object({
    variantId:z.string(),referenceId:z.string(),
    primaryMessage:z.string().max(400),
    readingOrder:z.array(z.object({layerId:z.string(),purpose:z.enum(['primary','product','qualifier','action','legal']),
      reason:z.string().max(300)}).strict()).min(1).max(12),
    sourceTransfer:z.string().max(1200).describe('What the source communicates; which type/grouping/background treatments remain appropriate for this brief, and which must change.'),
    typography:z.string().max(1000).describe('Exact font IDs, intended line breaks, relative prominence, baseline/alignment grouping and relation to the selected reference.'),
    logoTreatment:z.string().max(600).describe('Original logo variant, calm background or evidenced badge, proportional clearance and edge distance.'),
    backgroundConstruction:z.string().max(1000).describe('Pinned materials/lighting/curves and their compositional purpose. No invented source features.'),
  }).strict()).min(1).max(12),
  variants:planSchema.shape.variants,generatedAssets:planSchema.shape.generatedAssets,
}).strict();

export const inspectedReviewSchema=reviewSchema.extend({
  inspections:z.array(z.object({variantId:z.string(),referenceId:z.string(),
    firstRead:z.string().max(400),typography:z.string().max(700),
    logo:z.string().max(600),backgroundAndKV:z.string().max(700),
    sourceFidelity:z.string().max(700),
  }).strict()).max(12),
}).strict();

export function validateArtDirection(plan:z.infer<typeof artDirectionSchema>,referenceIds:string[]){
  if(plan.directions.length!==plan.variants.length)throw Error('Не для каждого варианта задана композиционная идея');
  const ids=new Set<string>();
  for(const d of plan.directions){
    const v=plan.variants.find(v=>v.id===d.variantId);
    if(!v||ids.has(d.variantId))throw Error('Композиционная идея ссылается на неизвестный или повторный вариант');
    ids.add(d.variantId);
    if(referenceIds.length&&!referenceIds.includes(d.referenceId))throw Error('Выбран отсутствующий визуальный пример');
    if(d.readingOrder.some(item=>!v.layers.some(l=>l.id===item.layerId&&(l.kind==='text'||item.purpose==='product'&&l.kind==='image'))))
      throw Error('Порядок чтения ссылается на отсутствующий текст или продукт');
  }
}

export function validateInspections(review:z.infer<typeof inspectedReviewSchema>,variants:Variant[]){
  const ids=review.inspections.map(i=>i.variantId);
  if(ids.length!==variants.length||new Set(ids).size!==variants.length||variants.some(v=>!ids.includes(v.id)))
    throw Error('Визуальная проверка должна отдельно рассмотреть каждый вариант');
  if(review.issues.some(i=>!variants.some(v=>v.id===i.variantId)))throw Error('Проверка ссылается на неизвестный вариант');
}

/** Relative values expose weak hierarchy to vision review; they never reject a design. */
export function typographyObservations(variants:Variant[],reports:{textBoxes:unknown[]}[]){
  return variants.map((v,index)=>({variantId:v.id,canvas:{width:v.width,height:v.height},
    texts:v.layers.filter(l=>l.kind==='text').map(l=>({id:l.id,role:l.role,text:l.text,fontId:l.fontId,
      fontSize:l.fontSize,relativeHeight:l.fontSize/v.height,lineHeight:l.lineHeight,
      tracking:l.appearance?.letterSpacing??0,align:l.align,
      measured:(reports[index]?.textBoxes as any[])?.find(b=>b.id===l.id)}))}));
}

export const visualInspectionGuide=`Inspect every output separately against its own source, at full size and as a small advertisement.
First read the visible words, not its layer roles. State what attracts attention FIRST and whether it is the actual offer.
Compare headline/product/qualifier sizes AND weights, line breaks, line spacing, alignment and grouping with the source.
For fitted line highlights or pills, compare padding to measured inkBounds, not the authored text container.
Inspect all four sides: a large unused tail or low baseline inside a copied tight strip changes its typographic character.
A qualifying condition must remain legible without accidentally becoming a competing headline. Do not impose a universal size ratio.
Inspect original logo shape/variant, contrast, cap-height-based clearspace, edge clearance and the actual badge interior.
Inspect the exact brand spelling, quotation marks, inflection, nonbreaking names, percentages and currencies using editorial evidence.
Inspect background lighting, dimensional materials, overlap/crop and quiet text zones. Name specific differences from the chosen reference.
Do not praise generic color matching or extra effects. A copied container is wrong if its original communicative purpose is absent.
Explicit source rules can be errors. Uncertain art-direction judgments are suggestions with concrete layer-level corrections, not vetoes.`;
