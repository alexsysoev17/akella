/** Presentation-only resolution. Never put these fields into MotionState/settings. */
export const previewScales = { full:1, half:1/2, third:1/3, quarter:1/4 } as const;
export type RenderQuality = keyof typeof previewScales;
export type PreviewQuality = RenderQuality|'auto';
export function renderDimensions(projectWidth:number,projectHeight:number,scale:number){
 if(!Number.isFinite(scale)||scale<=0||scale>4)throw Error('INVALID_RENDER_SCALE');
 return {width:Math.max(1,Math.round(projectWidth*scale)),height:Math.max(1,Math.round(projectHeight*scale))};
}
export const previewProtocolVersion='native-preview-quality/1';
