import {createHash} from 'node:crypto';
import type {CanvasKit} from 'canvaskit-wasm';
import type {LoadedProject,NativeTextPoseProof} from '../types.js';
import {buildRegistry,resolveState} from '../motion/registry.js';
import {drawText,makeText,type NativeText} from './text.js';
import {makeSurface} from './skia.js';
import type {FontResources} from './fonts.js';

const hash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const cache=new Map<string,NativeTextPoseProof>();
/** Only ambiguous normalization needs native evidence. Equal boxes keep existing behavior. */
export function textPoseCandidates(project:LoadedProject){
  return buildRegistry(project.inspection.document,project.inspection.fingerprint).objects.flatMap(object=>{
    if(object.states.length<2||object.ambiguousScenes.length)return [];
    const refs=object.states.map(ref=>resolveState(project.inspection.document,object,ref.sceneId));
    if(!refs.every(r=>r.node.type==='TEXT'))return [];
    if(refs.every(r=>r.width===refs[0].width&&r.height===refs[0].height))return [];
    return [{object,refs}];
  });
}
function shaped(layout:NativeText){
  return {height:layout.height,offsetY:layout.offsetY,paragraphs:layout.paragraphs.map(p=>({
    y:p.y,start:p.start,end:p.end,lines:p.paragraph.getShapedLines().map(l=>({
      textRange:l.textRange,top:l.top,bottom:l.bottom,baseline:l.baseline,runs:l.runs.map(r=>({
        size:r.size,fakeBold:r.fakeBold,fakeItalic:r.fakeItalic,glyphs:Array.from(r.glyphs),positions:Array.from(r.positions),offsets:Array.from(r.offsets),flags:r.flags,
      })),
    })),
  }))};
}
/** Exact glyph positioning AND native ink, since CanvasKit does not expose a reliable run face ID.
 * ALL refs must agree; a genuinely different layout/paint keeps legacy box interpolation.
 * The comparison canvas is shared and independent of empty source-box margins. */
export function deriveNativeTextPose(project:LoadedProject,kit:CanvasKit,resources:FontResources,prepared?:Map<string,NativeText>):NativeTextPoseProof{
  const fontFilesDigest=hash(JSON.stringify(resources.manifest)),key=hash(JSON.stringify([project.inspection.fingerprint,fontFilesDigest]));
  const old=cache.get(key);if(old)return structuredClone(old);
  const result:NativeTextPoseProof={version:'native-text-pose/1',sourceFingerprint:project.inspection.fingerprint,fontFilesDigest,groups:{},diagnostics:[]};
  let remainingPixels=128e6,remainingRefs=256;
  const candidates=textPoseCandidates(project);
  if(candidates.length>64)result.diagnostics.push({logicalObjectId:'',reason:'TEXT_POSE_LEGACY: more than64 candidate objects; remaining objects retain source-box poses'});
  for(const {object,refs} of candidates.slice(0,64)){
    const owned:NativeText[]=[];
    try{
      if(refs.length>64)throw Error('reference count exceeds bounded native proof');
      if(refs.length>remainingRefs)throw Error('total native reference proof budget reached');remainingRefs-=refs.length;
      if(refs.some(r=>(r.node.children??[]).length||r.node.properties.isMask||r.node.properties.clipsContent||(r.node.properties.effects as {visible?:boolean}[]|undefined)?.some(e=>e.visible!==false)||(r.node.properties.strokes as {visible?:boolean}[]|undefined)?.some(e=>e.visible!==false)))throw Error('effects, strokes, mask or subtree need separate native proof');
      const layouts=refs.map(r=>{const existing=prepared?.get(r.sourceNodeId);if(existing)return existing;const layout=makeText(kit,resources,r.node as Parameters<typeof makeText>[2]);owned.push(layout);return layout;});
      if(layouts.some(l=>l.warnings.some(w=>w.startsWith('Missing font'))))throw Error('requested font missing; fallback is not source-font proof');
      const shapes=layouts.map(l=>shaped(l)),shapeDigests=shapes.map(s=>hash(JSON.stringify(s)));
      if(new Set(shapeDigests).size!==1)throw Error('shaped glyphs, positions or line layout differ');
      const largestSize=Math.max(1,...shapes.flatMap(s=>s.paragraphs.flatMap(p=>p.lines.flatMap(l=>l.runs.map(r=>r.size))))),pad=Math.ceil(largestSize*2)+8;
      const left=Math.floor(Math.min(0,...layouts.flatMap(l=>l.lines.map(v=>v.x)))),right=Math.ceil(Math.max(1,...layouts.flatMap(l=>l.lines.map(v=>v.x+v.width)))),bottom=Math.ceil(Math.max(1,...layouts.map(l=>l.height+l.offsetY)));
      const width=right-left+pad*2,height=bottom+pad*2;
      if(width*height*4>16e6)throw Error('canonical ink proof exceeds16M pixel bound');
      const pixels=width*height*5*layouts.length;
      if(pixels>remainingPixels)throw Error('total canonical ink proof budget reached');remainingPixels-=pixels;
      const inks=layouts.map(layout=>{
        const digests:string[]=[];let visible=false;
        for(const density of [1,2]){
          const w=width*density,h=height*density,surface=makeSurface(kit,w,h);
          try{
            const canvas=surface.getCanvas();canvas.scale(density,density);canvas.translate(pad-left,pad);drawText(kit,canvas,layout);surface.flush();
            const image=surface.makeImageSnapshot();try{
              const pixels=image.readPixels(0,0,{width:w,height:h,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB});
              if(!pixels)throw Error('canonical ink pixels unavailable');
              for(let i=3;i<pixels.length;i+=4)if(pixels[i]){visible=true;break;}
              digests.push(hash(pixels as Uint8Array));
            }finally{image.delete();}
          }finally{surface.dispose();}
        }
        if(!visible)throw Error('no visible glyph ink');return hash(JSON.stringify(digests));
      });
      if(new Set(inks).size!==1)throw Error('canonical native ink differs');
      result.groups[object.logicalObjectId]={width:Math.max(...refs.map(r=>r.width)),height:Math.max(...refs.map(r=>r.height)),shapeDigest:shapeDigests[0],inkDigest:inks[0],refs:object.states.map(r=>({...r}))};
    }catch(error){result.diagnostics.push({logicalObjectId:object.logicalObjectId,reason:`TEXT_POSE_LEGACY: ${error instanceof Error?error.message:String(error)}`});}
    finally{owned.forEach(l=>l.dispose());}
  }
  if(cache.size>=16)cache.delete(cache.keys().next().value!);cache.set(key,structuredClone(result));return result;
}
