import test from 'node:test';import assert from 'node:assert/strict';
import {textViewportOffset} from '../src/motion/text-clearance.js';
test('text viewport clearance follows movement direction and entrance/exit endpoints for every side',()=>{
 const points=[{x:40,y:30},{x:140,y:30},{x:140,y:50},{x:40,y:50}],viewport={x:0,y:0,width:300,height:200};
 for(const [effect,input,output] of [['slideLeft',{x:261,y:0},{x:-141,y:0}],['slideRight',{x:-141,y:0},{x:261,y:0}],['slideUp',{x:0,y:171},{x:0,y:-51}],['slideDown',{x:0,y:-51},{x:0,y:171}]] as const){
  assert.deepEqual(textViewportOffset(points,viewport,effect,'in'),input);assert.deepEqual(textViewportOffset(points,viewport,effect,'out'),output);
 }
});
