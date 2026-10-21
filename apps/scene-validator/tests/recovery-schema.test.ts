import test from "node:test";
import assert from "node:assert/strict";
import {z} from "zod";
import {compatibleSchema, normalizeProviderOutput} from "../src/motion/provider.js";
import {objectEnvelope,validateProviderSchema} from "../src/harness/providers/schema.js";
import {CodexAdapter} from "../src/harness/providers/codex.js";
import {transportErrorCode} from "../src/harness/providers/types.js";
import {recoveryDecisionSchema} from "../src/harness/recovery/runtime.js";
import {recoveryFailure} from "../src/harness/recovery/failure.js";
test("actual Recovery union root is rejected locally, enveloped schema validates without flattening its branches", async()=>{
 const runtime=z.toJSONSchema(recoveryDecisionSchema,{io:"output",reused:"ref"});
 const broken=compatibleSchema(runtime);
 assert.throws(()=>validateProviderSchema(broken),/PROVIDER_SCHEMA_INVALID/);
 await assert.rejects(()=>new CodexAdapter("codex-sdk","/nonexistent-not-used").generate({messages:[],responseSchema:broken,timeoutMs:1,maxOutputTokens:100}),/PROVIDER_SCHEMA_INVALID/);
 const wire=objectEnvelope(broken);assert.equal(wire.wrapped,true);validateProviderSchema(wire.schema);
 const output={action:"inspect",queries:[{tool:"inspectTimeline",id:null,name:null}],reason:"canonical state"};
 const normalized=normalizeProviderOutput(output,runtime);
 assert.deepEqual(recoveryDecisionSchema.parse(normalized),{action:"inspect",queries:[{tool:"inspectTimeline"}],reason:"canonical state"});
 const failure=recoveryFailure(new Error("PROVIDER_SCHEMA_INVALID"),"recovery","r");assert.equal(failure.codeRepairEligible,true);assert.equal(failure.recoverable,false);
});
test("strict dictionary encoding is reversible, duplicate keys fail and schema/transport defects stay distinct",()=>{
 const runtime=z.toJSONSchema(z.object({parameters:z.record(z.string(),z.number())}).strict(),{io:"output"});
 const wire=compatibleSchema(runtime);validateProviderSchema(wire);
 assert.deepEqual(normalizeProviderOutput({parameters:[{key:"amplitude",value:0.5}]},runtime),{parameters:{amplitude:0.5}});
 assert.throws(()=>normalizeProviderOutput({parameters:[{key:"x",value:1},{key:"x",value:2}]},runtime),/duplicate/);
 assert.equal(transportErrorCode(new Error("400 invalid_json_schema schema must be object")),"PROVIDER_SCHEMA_INVALID");
 assert.equal(transportErrorCode(new Error("ECONNREFUSED")),"PROVIDER_UNAVAILABLE");
 assert.equal(transportErrorCode(new Error("401 unauthorized")),"PROVIDER_AUTH_FAILED");
});
