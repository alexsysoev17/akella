/** This document displays server-produced pixels. It does not evaluate or paint a scene. */
export function nativePreviewHtml(
  base: string,
  width: number,
  height: number,
  revision: string,
) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}canvas{position:absolute;width:100%;height:100%;object-fit:contain;image-rendering:auto;user-select:none}#warning{position:absolute;bottom:0;left:0;right:0;font:11px sans-serif;color:#ffe9a1;background:#222b;max-height:3em;overflow:auto}#error{z-index:2;position:absolute;bottom:0;left:0;right:0;font:12px sans-serif;color:#fff;background:#8b0000;white-space:pre-wrap}</style></head><body><canvas id="native-frame"></canvas><div id="warning" hidden></div><div id="error" hidden></div><script>
const base=${JSON.stringify(base)},width=${width},height=${height};let revision=${JSON.stringify(revision)},wanted=0,displayed=-1,running=false,controller,last,ready=false,requesting=0,closed=false;
const img=document.getElementById('native-frame'),error=document.getElementById('error'),source=document.createElement('canvas');
function present(){if(!source.width||!last)return;const ratio=Math.min(innerWidth/last.width,innerHeight/last.height),density=window.devicePixelRatio||1,w=Math.max(1,Math.min(last.width,Math.round(last.width*ratio*density))),h=Math.max(1,Math.min(last.height,Math.round(last.height*ratio*density)));if(img.width!==w||img.height!==h){img.width=w;img.height=h;}const c=img.getContext('2d');c.imageSmoothingEnabled=true;c.imageSmoothingQuality='high';c.clearRect(0,0,w,h);c.drawImage(source,0,0,w,h);document.body.dataset.sourceSize=last.width+'x'+last.height;document.body.dataset.displaySize=w+'x'+h;}
addEventListener('resize',present);
async function load(){if(running||closed)return;running=true;const requested=wanted;requesting=requested;controller=new AbortController();try{
 const response=await fetch(base+'/frame?transport=packet&frame='+requested+'&revision='+encodeURIComponent(revision),{signal:controller.signal});if(!response.ok){const e=await response.json();throw Error(e.error||response.statusText);}
 const bytes=await response.arrayBuffer(),length=new DataView(bytes).getUint32(0),metadata=JSON.parse(new TextDecoder().decode(new Uint8Array(bytes,4,length)));
 if(Math.abs(wanted-requested)>30)return;
 if(source.width!==metadata.width||source.height!==metadata.height){source.width=metadata.width;source.height=metadata.height;}source.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(bytes,4+length),metadata.width,metadata.height),0,0);last=metadata;present();displayed=requested;error.hidden=true;error.textContent="";
 document.body.dataset.nativeRenderer=metadata.renderer;document.body.dataset.renderedFrame=String(requested);document.body.dataset.renderWarnings=JSON.stringify(metadata.warnings);const warning=document.getElementById('warning');warning.hidden=!metadata.warnings.length;warning.textContent=metadata.warnings.join(' · ');
 if(!ready){ready=true;parent.postMessage({type:'motion-ready',renderer:metadata.renderer},location.origin);}
 }catch(e){if(e.name!=='AbortError'){error.hidden=false;error.textContent=e.message;parent.postMessage({type:'motion-render-error',error:e.message},location.origin);}}
 finally{running=false;if(displayed!==wanted&&!error.textContent)load();else if(displayed!==wanted&&error.hidden)load();}}
window.motionFrame=(frame)=>{wanted=Math.max(0,Math.floor(frame));if(running&&Math.abs(wanted-requesting)>30)controller?.abort();load();};
addEventListener('message',event=>{if(event.source!==parent||event.origin!==location.origin)return;if(event.data?.type==='motion-frame')window.motionFrame(event.data.frame);if(event.data?.type==='motion-state'){if(event.data.revision&&revision!==event.data.revision){revision=event.data.revision;controller?.abort();displayed=-1;}load();}});
img.addEventListener('click',event=>{if(!last)return;const scale=Math.min(innerWidth/width,innerHeight/height),x=(event.clientX-(innerWidth-width*scale)/2)/scale,y=(event.clientY-(innerHeight-height*scale)/2)/scale;
 const hit=[...last.hits].reverse().find(h=>{let inside=false;for(let i=0,j=h.points.length-1;i<h.points.length;j=i++){const a=h.points[i],b=h.points[j];if((a.y>y)!==(b.y>y)&&x<(b.x-a.x)*(y-a.y)/(b.y-a.y)+a.x)inside=!inside;}return inside;});if(hit)parent.postMessage({type:'motion-select',sceneId:hit.sceneId,targetId:hit.targetId},location.origin);});
addEventListener('pagehide',()=>{closed=true;controller?.abort();});load();
</script></body></html>`;
}
