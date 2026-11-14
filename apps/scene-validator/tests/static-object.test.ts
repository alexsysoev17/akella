import test from "node:test";
import assert from "node:assert/strict";
import {identityFixture,node} from "./identity-fixture.js";
import {logicalId} from "../src/motion/registry.js";
import {freezeObjectOperations} from "../src/motion/static-object.js";
import {applyOperations,motionDiff} from "../src/motion/operations.js";
import {lowerMotionTool} from "../src/motion/tools.js";
import {inspectSemanticCoverage} from "../src/motion/intent/coverage.js";
import {objectRequirement} from "./intent-fixture.js";
test("freeze cascades owned child transitions, preserves unrelated objects and releases through typed mutation",async()=>{
 const f=await identityFixture(2,scenes=>scenes.forEach((s,i)=>{const g=node(`group${i}`,"Group",20,20,80,60,[node(`child${i}`,"Child",30,30)]);g.type="GROUP";s.children=[g,node(`other${i}`,"Other",120,70)];}));
 try{
  f.state.objectTransitions=[{...f.transition,transitionId:"child-transition",logicalObjectId:logicalId("Child"),fromSceneId:"s0",toSceneId:"s1",timelinePolicy:"referenceStates",startFrame:1,durationFrames:6}];
  const state=applyOperations(f.state,freezeObjectOperations(f.project,f.state,logicalId("Group")),f.project);
  assert.equal(state.objectTransitions?.length,0);assert.equal(state.staticObjects?.length,1);
  assert.ok(motionDiff(f.state,state).some(d=>d.path.startsWith("staticObjects")),"Inspector diff includes persistent lifetime changes");
  const released=applyOperations(state,lowerMotionTool(f.project,state,{tool:"releaseStaticObject",logicalObjectId:logicalId("Group")}),f.project);
  assert.equal(released.staticObjects?.length,0);
 }finally{await f.cleanup();}
});
test("unsupported ancestor clipping is a precise capability failure, not a degraded static presentation",async()=>{
 const f=await identityFixture(1,scenes=>{const g=node("g","Clipped parent",0,0,40,40,[node("child","Child",25,25)]);g.type="FRAME";g.properties.clipsContent=true;scenes[0].children=[g];});
 try{assert.throws(()=>freezeObjectOperations(f.project,f.state,logicalId("Child")),/ENGINE_CAPABILITY_MISSING/);assert.equal(f.state.staticObjects,undefined);}finally{await f.cleanup();}
});
test("coverage rejects a single-track deletion when the explicit requirement is whole-video static visibility",async()=>{
 const f=await identityFixture(1,scenes=>{scenes[0].children=[node("x","Object")];});
 try{
  const source="Удали движение Object, пусть он статичен весь ролик";
  const requirement=objectRequirement("r","s0","x","Object",[],source);
  requirement.kind="editAnimation";requirement.effectOperation={storage:"animation",action:"remove"};
  const plan={schemaVersion:"1.0.0" as const,requirements:[requirement],coverage:[{sourceText:source,requirementIds:["r"],classification:"executable" as const,explanation:"fixture"}],assumptions:[]};
  assert.ok(inspectSemanticCoverage(f.project,source,plan).issues.some(i=>i.code==="MISSING_STATIC_LIFETIME_REQUIREMENT"));
  requirement.motionAction="freezeProject";
  assert.equal(inspectSemanticCoverage(f.project,source,plan).issues.some(i=>i.code==="MISSING_STATIC_LIFETIME_REQUIREMENT"),false);
 }finally{await f.cleanup();}
});
