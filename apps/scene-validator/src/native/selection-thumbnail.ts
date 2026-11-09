import type {LoadedProject} from '../types.js';
import {defaultMotion} from '../motion/context.js';
import {renderNativeFrame} from './client.js';

/** Isolated, unanimated local-space thumbnail. Never mutates source or saved motion. */
export async function selectionThumbnail(project:LoadedProject,sceneId:string,targetId:string){
 const scene=project.inspection.document.scenes.find(s=>s.sceneId===sceneId);
 if(!scene)throw new Error('Scene not found');
 const find=(node:any):any=>node.figmaNodeId===targetId?node:(node.children??[]).map(find).find(Boolean);
 const target=find(scene);if(!target||target===scene)throw new Error('Object not found');
 const width=Math.max(1,Number(target.properties?.width??target.width??1)),height=Math.max(1,Number(target.properties?.height??target.height??1));
 if(!Number.isFinite(width)||!Number.isFinite(height))throw new Error('Invalid object dimensions');
 const padding=Math.max(width,height)*.05,identity=[[1,0,0],[0,1,0]];
 const isolated:any=structuredClone(scene),child=structuredClone(target);
 child.properties={...child.properties,x:padding,y:padding,visible:true,opacity:1,relativeTransform:[[1,0,padding],[0,1,padding]]};child.sceneTransform=child.properties.relativeTransform;child.parentId=scene.figmaNodeId;
 isolated.children=[child];isolated.width=Math.ceil(width+2*padding);isolated.height=Math.ceil(height+2*padding);
 isolated.properties={...isolated.properties,x:0,y:0,width:isolated.width,height:isolated.height,relativeTransform:identity,fills:[],backgrounds:[],strokes:[],effects:[],opacity:1};
 isolated.fills=[];isolated.background=[];isolated.opacity=1;isolated.clipsContent=false;isolated.transform=identity;isolated.sceneTransform=identity;
 const view={...project,inspection:{...project.inspection,fingerprint:project.inspection.fingerprint+':selection:'+sceneId+':'+targetId,document:{...project.inspection.document,scenes:[isolated]}}};
 const state=defaultMotion(view);state.settings.width=isolated.width;state.settings.height=isolated.height;
 return renderNativeFrame(view,state,0,{scale:Math.min(1,320/Math.max(isolated.width,isolated.height))});
}
