import {semanticEditSchema} from './rule-contract.js';
import type {LogicalObject} from './registry.js';
export function parseAnchorEdit(request:string,objects:LogicalObject[],editor?:{selectedSceneId?:string;activeSceneId?:string;currentFrame?:number}){
 const text=request.toLowerCase();if(/инерц|колеб|покач|wiggle|spring|отскок|фейд|fade|прозрач|easing|изинг/iu.test(text)||/(?:не|кроме|исключая)\s+(?:в\s+)?(?:центр|лев|прав|верх|нижн)/iu.test(text))return null;let point:{units:'normalized'|'pixels';x:number;y:number}|undefined;
 const x=/лев/iu.test(text)?0:/прав/iu.test(text)?1:.5,y=/верх/iu.test(text)?0:/нижн/iu.test(text)?1:.5;
 if(/центр|center|угол|верхн|нижн/iu.test(text))point={units:'normalized',x,y};
 const absolute=text.match(/(-?\d+(?:\.\d+)?)\s*[,;]\s*(-?\d+(?:\.\d+)?)/u);if(absolute)point={units:/normalized|нормализован/iu.test(text)?'normalized':'pixels',x:Number(absolute[1]),y:Number(absolute[2])};
 let action='SET_ANCHOR';
 if(/сброс|reset/iu.test(text))action='RESET_ANCHOR';
 if(/смест|сдвин/iu.test(text)){const move=text.match(/на\s+(\d+(?:\.\d+)?)\s*(?:пиксел\S*|px)\s*(вправо|влево|вверх|вниз)/u);if(!move)return null;const amount=Number(move[1]);action='MOVE_ANCHOR';point={units:'pixels',x:/право|лево/u.test(move[2])?amount*(move[2]==='влево'?-1:1):0,y:/вверх|вниз/u.test(move[2])?amount*(move[2]==='вверх'?-1:1):0};}
 if(!point&&action!=='RESET_ANCHOR')return null;
 if(/после|затем|секунд|одновременно|сначала/iu.test(text))return null;
 const sceneId=editor?.selectedSceneId??editor?.activeSceneId;
 return semanticEditSchema.parse({operation:action,effect:'anchor',targets:objects.map(o=>o.logicalObjectId),scope:{selector:'objects',...(sceneId?{sceneId}:{})},parameters:{},anchor:{action,point,scope:'object',space:/композици|composition/iu.test(text)?'composition':'local',frame:editor?.currentFrame??0,preserveVisualPosition:!/без сохран|не сохраня|новое движение/iu.test(text)}});
}
