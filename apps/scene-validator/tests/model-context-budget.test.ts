import test from 'node:test';import assert from 'node:assert/strict';
import {providerBudget,prepareProviderRequest,requestContextCategories} from '../src/harness/providers/budget.js';
import {packContext} from '../src/harness/context-packing.js';
import {harnessConfigSchema} from '../src/harness/config.js';
const adapter={id:'model-profile',mode:'mock' as const,capabilities:()=>({structuredOutput:true,nativeToolCalling:false,cancellation:true,usage:false,nativeOutputTokenLimit:false}),generate:async()=>{throw Error('no model calls');}};
const req={purpose:'semantic-planning' as const,messages:[{role:'system' as const,content:'system'},{role:'user' as const,content:JSON.stringify({userRequest:'поменяй анимацию',context:{motion:{animations:Array.from({length:1000},(_,i)=>({id:'id'+i,parameters:'x'.repeat(100)}))}}})}],responseSchema:{type:'object'},timeoutMs:1000,maxOutputTokens:16000,model:'large'};
test('model window, schema/tools/output/reasoning/transport reserves replace universal 60KB gate, while explicit resource caps still hold',()=>{
 const profile={provider:adapter.id,model:'large',contextWindowTokens:500000,maxOutputTokens:32000,transportOverheadTokens:32768,reasoningReserveTokens:8192,source:'configured synthetic fixture'};
 const budget=providerBudget(adapter,req,harnessConfigSchema.parse({}).maxContextBytes,[profile]);assert.ok(budget.totalBytes>60000);assert.notEqual(budget.inputTokens,budget.totalBytes);assert.equal(budget.profileStatus,'RESOLVED');assert.equal(budget.reasoningReserveTokens,8192);
 assert.throws(()=>providerBudget(adapter,req,60000,[profile]),/CONTEXT_EXHAUSTED/);
 assert.throws(()=>providerBudget(adapter,req,2000000,[{...profile,contextWindowTokens:8000}]),/Model window/);
 assert.equal(providerBudget(adapter,{...req,messages:[]},2000000).profileStatus,'UNKNOWN_MODEL_CONSERVATIVE');
 assert.equal(prepareProviderRequest(adapter,req,2000000,[profile]).report.modelBudget?.profile?.model,'large');
});
test('packed context categories retain actual semantic attribution and enumerate remaining metadata instead of a hidden encoding blob',()=>{
 const context={objectIndex:[{name:'текст 2',id:'a'}],motion:{animations:[{id:'a'}]},motionKnowledge:{skills:['motion']},recentConversation:['request'],project:{fps:30},extraGuidance:['keep user timing']};
 const packed=packContext(context),cat=requestContextCategories({...req,messages:[{role:'user',content:JSON.stringify({userRequest:'позже',context:packed.value})}]});
 assert.ok(cat.objectContext>0);assert.ok(cat.motionGraph>0);assert.ok(cat.skills>0);assert.ok(cat.conversationHistory>0);assert.ok(cat.projectSnapshot>0);assert.ok(cat.otherFields.extraGuidance>0);assert.equal(cat.otherFields.data,undefined);
});
