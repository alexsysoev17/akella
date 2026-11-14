import test from 'node:test';
import assert from 'node:assert/strict';
import {motionObservations} from '../src/motion/motion-observations.js';
import type {MotionState} from '../src/motion/schema.js';
test('reports the actual stop/tail velocity discontinuity without rejecting artistic motion',()=>{
 const state={settings:{fps:30},blocks:[{sceneId:'s',startFrame:240}],animations:[{animationId:'entry',sceneId:'s',targetId:'star',enabled:true,startFrame:240,durationFrames:24,easing:'easeInOutExpo',effect:'keyframes',parameters:{property:'y',points:[{frame:0,value:240},{frame:24,value:0}]}}],expressions:[{expressionId:'tail',sceneId:'s',targetId:'star',enabled:true,type:'inertialOvershoot',sourceAnimationId:'entry',property:'y',startFrame:264,durationFrames:36,parameters:{amplitude:1.2,frequency:3,decay:6,mode:'ae',velocitySampling:'lookback',velocityLookbackFrames:12,settlingEnvelope:'smoothTail'}}]} as unknown as MotionState;
 const before=JSON.stringify(state),r=motionObservations(state),tail=r.inertia[0];assert.equal(r.advisoryOnly,true);assert.ok(Math.abs(tail.incomingStep!)<.1);assert.ok(Math.abs(tail.firstTailStep!)>170);assert.ok(tail.peakTail!>220);assert.equal(JSON.stringify(state),before);
 state.animations[0].startFrame=0;assert.deepEqual(motionObservations(state).timing,[{id:'entry',startSeconds:0,sceneMarkerSeconds:8}]);
});
