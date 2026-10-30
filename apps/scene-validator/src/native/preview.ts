import {previewScales,previewProtocolVersion,type PreviewQuality} from './quality.js';
/** The browser displays server pixels and UI only. Logical hits remain in project coordinates. */
export function nativePreviewHtml(base:string,width:number,height:number,revision:string,options:{quality?:PreviewQuality;fps?:number;durationFrames?:number;sourceFingerprint?:string}={}) {
 const config={base,width,height,revision,quality:options.quality??'full',fps:options.fps??30,durationFrames:options.durationFrames??108001,sourceFingerprint:options.sourceFingerprint??'',scales:previewScales,version:previewProtocolVersion};
 return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#1a1a1a}canvas{position:absolute;width:100%;height:100%;object-fit:contain;image-rendering:auto;user-select:none}#warning{position:absolute;bottom:0;left:0;right:0;font:11px sans-serif;color:#f2f2f2;background:#1a1a1a;max-height:3em;overflow:auto}#error{z-index:2;position:absolute;bottom:0;left:0;right:0;font:12px sans-serif;color:#f2f2f2;background:#1a1a1a;white-space:pre-wrap}</style></head><body><canvas id="native-frame"></canvas><div id="warning" hidden></div><div id="error" hidden></div><script>
const config=${JSON.stringify(config)},base=config.base,width=config.width,height=config.height,scales=config.scales;
let revision=config.revision,fingerprint=config.sourceFingerprint,mode=config.quality,wanted=0,displayed=-1,displayedGeneration=-1,playing=false,generation=0,serial=0,running=false,controller,last,ready=false,closed=false,idleTimer,refineTimer,scrubUntil=0;
let playbackScale=.5,lastTune=-2500,slow=0,fast=0,autoIdleLimit=1,qualityLimitReason=null;
const session=globalThis.crypto?.randomUUID?.()||String(Date.now())+'-'+Math.random().toString(36).slice(2),started=performance.now(),cache=new Map(),samples=[];
let cacheBytes=0,clientHits=0,workerHits=0,requests=0,cancelled=0,peakRSS=0,firstPreviewMs=null,lastMetrics=0;
const img=document.getElementById('native-frame'),error=document.getElementById('error'),source=document.createElement('canvas');
function key(frame,scale){return [config.version,revision,fingerprint,width,height,frame,scale].join('/');}
function targetScale(){if(mode!=='auto')return scales[mode];const desired=playing?playbackScale:performance.now()<scrubUntil?.25:autoIdleLimit;return [1,.5,1/3,.25].find(s=>s<=desired&&Math.max(1,Math.round(width*s))*Math.max(1,Math.round(height*s))<=33554432)??.25;}
function metrics(force=false){if(!last)return;const now=performance.now();if(!force&&now-lastMetrics<200)return;lastMetrics=now;
 const rows=samples.filter(s=>s.scale===last.previewScale).map(s=>s.ms).sort((a,b)=>a-b),box=img.getBoundingClientRect();
 const data={quality:mode,qualityLimitReason,actualQuality:last.previewQuality??String(last.previewScale),projectResolution:width+'×'+height,requestedRenderResolution:last.requestedRenderResolution??{width:last.width,height:last.height},actualRenderResolution:{width:last.width,height:last.height},previewScale:last.previewScale,viewportDisplay:{width:box.width,height:box.height},frameIndex:last.frame,projectRevision:last.revision,renderDurationMs:last.stats?.milliseconds??null,deliveryLatencyMs:last.deliveryLatencyMs,averageFrameTimeMs:rows.length?rows.reduce((a,b)=>a+b,0)/rows.length:null,p95FrameTimeMs:rows.length?rows[Math.ceil(rows.length*.95)-1]:null,measuredSamples:rows.length,cacheHitRate:requests?(clientHits+workerHits)/requests:null,clientCacheBytes:cacheBytes,workerCache:last.cache??null,resourceReuse:last.resourceReuse??null,resources:last.stats??null,sampledPeakRSS:peakRSS,nativeMemory:last.nativeMemory??null,timeToFirstPreviewMs:firstPreviewMs,cancelledStaleJobs:cancelled,frameLag:Math.max(0,wanted-last.frame),fps:config.fps};
 window.nativePreviewMetrics=data;parent.postMessage({type:'motion-preview-metrics',metrics:data},location.origin);
}
function present(){if(!source.width||!last)return;
 const ratio=Math.min(innerWidth/width,innerHeight/height),density=window.devicePixelRatio||1,w=Math.max(1,Math.min(last.width,Math.round(width*ratio*density))),h=Math.max(1,Math.min(last.height,Math.round(height*ratio*density)));
 if(img.width!==w||img.height!==h){img.width=w;img.height=h;}const c=img.getContext('2d');c.imageSmoothingEnabled=true;c.imageSmoothingQuality='high';c.clearRect(0,0,w,h);c.drawImage(source,0,0,w,h);
 document.body.dataset.sourceSize=last.width+'x'+last.height;document.body.dataset.displaySize=w+'x'+h;document.body.dataset.previewQuality=mode;document.body.dataset.previewScale=String(last.previewScale);metrics();}
addEventListener('resize',present);
function show(metadata,bytes,local=false){
 if(source.width!==metadata.width||source.height!==metadata.height){source.width=metadata.width;source.height=metadata.height;}
 source.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(bytes),metadata.width,metadata.height),0,0);last=metadata;displayed=metadata.frame;displayedGeneration=generation;error.hidden=true;error.textContent='';present();
 document.body.dataset.nativeRenderer=metadata.renderer;document.body.dataset.renderedFrame=String(metadata.frame);document.body.dataset.renderWarnings=JSON.stringify(metadata.warnings??[]);const warning=document.getElementById('warning');warning.hidden=!(metadata.warnings??[]).length;warning.textContent=(metadata.warnings??[]).join(' · ');
 if(firstPreviewMs===null)firstPreviewMs=performance.now()-started;
 if(!ready){ready=true;parent.postMessage({type:'motion-ready',renderer:metadata.renderer},location.origin);}metrics(true);
}
function remember(k,metadata,bytes){const previous=cache.get(k);if(previous){cacheBytes-=previous.bytes.byteLength;cache.delete(k);}while(cache.size>=24||cacheBytes+bytes.byteLength>16*1024*1024){const old=cache.keys().next().value;if(old===undefined)break;cacheBytes-=cache.get(old).bytes.byteLength;cache.delete(old);}if(bytes.byteLength<=16*1024*1024){cache.set(k,{metadata,bytes});cacheBytes+=bytes.byteLength;}}
function abort(){if(running&&!controller?.signal.aborted){cancelled++;controller?.abort();}}
function refine(){clearTimeout(refineTimer);if(!playing&&last&&last.frame===wanted&&last.previewScale<targetScale())refineTimer=setTimeout(load,180);}
function tune(ms){if(mode!=='auto'||!playing||performance.now()-lastTune<2500)return;const budget=1000/config.fps;slow=ms>budget*1.5?slow+1:0;fast=ms<budget*.5?fast+1:0;
 if(playbackScale===.5&&slow>=6){playbackScale=.25;lastTune=performance.now();slow=fast=0;}
 else if(playbackScale===.25&&fast>=24){playbackScale=.5;lastTune=performance.now();slow=fast=0;}}
async function load(){if(running||closed)return;const desired=targetScale();
 if(last&&last.revision===revision&&last.frame===wanted&&last.previewScale===desired)return;
 let scale=desired;const exact=cache.get(key(wanted,desired));
 if(exact){requests++;clientHits++;show(exact.metadata,exact.bytes,true);return;}
 if(!playing&&(!last||last.revision!==revision||last.frame!==wanted)&&desired>.25)scale=.25;
 const cached=cache.get(key(wanted,scale));if(cached){requests++;clientHits++;show(cached.metadata,cached.bytes,true);refine();return;}
 running=true;const requested=wanted,rev=revision,g=generation,seq=++serial,requestScale=scale,requestKey=key(requested,scale);controller=new AbortController();const began=performance.now();requests++;
 try{
 const response=await fetch(base+'/frame?transport=packet&frame='+requested+'&scale='+requestScale+'&revision='+encodeURIComponent(rev)+'&viewport='+encodeURIComponent(session)+'&sequence='+seq+(fingerprint?'&fingerprint='+encodeURIComponent(fingerprint):''),{signal:controller.signal});
 if(!response.ok){const e=await response.json();throw Error(e.error||response.statusText);}
 const packet=await response.arrayBuffer(),length=new DataView(packet).getUint32(0),metadata=JSON.parse(new TextDecoder().decode(new Uint8Array(packet,4,length)));
 if(g!==generation||rev!==revision||metadata.revision!==revision||metadata.frame!==requested||(!playing&&requested!==wanted)||(playing&&displayedGeneration===g&&requested<displayed)){cancelled++;return;}
 if(metadata.width!==Math.max(1,Math.round(width*requestScale))||metadata.height!==Math.max(1,Math.round(height*requestScale)))throw Error('INVALID_RENDER_RESOLUTION');
 metadata.previewScale=requestScale;metadata.previewQuality=Object.keys(scales).find(k=>scales[k]===requestScale)??String(requestScale);metadata.deliveryLatencyMs=performance.now()-began;
 const pixels=packet.slice(4+length);if(pixels.byteLength!==metadata.width*metadata.height*4)throw Error('INVALID_FRAME_PACKET');
 peakRSS=Math.max(peakRSS,metadata.memory?.rss??0);if(metadata.cacheHit)workerHits++;else if(Number.isFinite(metadata.stats?.milliseconds)){samples.push({ms:metadata.stats.milliseconds,scale:requestScale});if(samples.length>120)samples.shift();tune(metadata.stats.milliseconds);}
 remember(requestKey,metadata,pixels);show(metadata,pixels);
 }catch(e){if(e.name!=='AbortError'&&g===generation&&!closed){if(mode==='auto'&&requestScale>.25&&/FRAME_SIZE_LIMIT|SURFACE_ALLOCATION_FAILED|out of memory|memory access out of bounds/i.test(e.message)){autoIdleLimit=requestScale>.5?.5:.25;playbackScale=Math.min(playbackScale,autoIdleLimit);qualityLimitReason=e.message;generation++;error.hidden=true;metrics(true);}else{error.hidden=false;error.textContent=e.message;parent.postMessage({type:'motion-render-error',error:e.message},location.origin);}}}
 finally{running=false;if(!closed&&error.hidden){if(displayed!==wanted)load();else refine();}}
}
function scheduleIdle(){clearTimeout(idleTimer);idleTimer=setTimeout(()=>{if(!playing){scrubUntil=0;load();}},250);}
window.motionFrame=(frame,options={})=>{const next=Math.max(0,Math.min(config.durationFrames-1,Math.floor(frame)));if(!Number.isFinite(next))return;
 const nextPlaying=Boolean(options.playing);if(nextPlaying!==playing||next<wanted||!nextPlaying&&next!==wanted){generation++;abort();}playing=nextPlaying;
 if(next!==wanted&&!playing){scrubUntil=performance.now()+200;scheduleIdle();}wanted=next;load();};
window.motionPreviewQuality=(quality)=>{if(quality!=='auto'&&!Object.hasOwn(scales,quality))return;mode=quality;autoIdleLimit=1;qualityLimitReason=null;generation++;abort();scrubUntil=0;document.body.dataset.previewQuality=mode;metrics(true);load();};
addEventListener('message',event=>{if(event.source!==parent||event.origin!==location.origin)return;const data=event.data;
 if(data?.type==='motion-frame')window.motionFrame(data.frame,{playing:data.playing});
 if(data?.type==='motion-preview-quality')window.motionPreviewQuality(data.quality);
 if(data?.type==='motion-playback'){if(playing!==Boolean(data.playing)){playing=Boolean(data.playing);generation++;abort();}if(!playing){scrubUntil=performance.now()+200;scheduleIdle();load();}}
 if(data?.type==='motion-state'){if(data.revision&&revision!==data.revision||data.sourceFingerprint&&fingerprint!==data.sourceFingerprint){revision=data.revision??revision;fingerprint=data.sourceFingerprint??fingerprint;generation++;abort();displayed=-1;last=null;cache.clear();cacheBytes=0;img.getContext('2d').clearRect(0,0,img.width,img.height);}load();}});
img.addEventListener('click',event=>{if(!last)return;const scale=Math.min(innerWidth/width,innerHeight/height),x=(event.clientX-(innerWidth-width*scale)/2)/scale,y=(event.clientY-(innerHeight-height*scale)/2)/scale;
 const hit=[...(last.hits??[])].reverse().find(h=>{let inside=false;for(let i=0,j=h.points.length-1;i<h.points.length;j=i++){const a=h.points[i],b=h.points[j];if((a.y>y)!==(b.y>y)&&x<(b.x-a.x)*(y-a.y)/(b.y-a.y)+a.x)inside=!inside;}return inside;});if(hit)parent.postMessage({type:'motion-select',sceneId:hit.sceneId,targetId:hit.targetId},location.origin);});
addEventListener('pagehide',()=>{closed=true;clearTimeout(idleTimer);clearTimeout(refineTimer);abort();cache.clear();});load();
</script></body></html>`;
}
