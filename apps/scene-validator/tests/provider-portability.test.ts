import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { AIClient } from "../src/motion/provider.js";
import {incrementalEditSchema} from '../src/motion/incremental-edit.js';
import {semanticGraphSchema} from '../src/motion/intent/graph.js';
import {intentPlanSchema} from '../src/motion/intent/schema.js';
import { providerSettingsSchema } from "../src/motion/provider-settings.js";
import {
  registerProvider,
  type ProviderCapabilities,
  type ProviderRequest,
} from "../src/harness/providers/index.js";

test('compact edit branch reverses strict optional-null wire adaptation without discarding invalid values',async()=>{
 const wire={edits:[{operation:'MODIFY_EFFECT',effect:'inertialOvershoot',ruleId:null,targets:['logo'],excludedTargets:[],scope:{selector:'objects',logicalObjectIds:['logo'],sceneId:null,startSeconds:null,endSeconds:null,phase:'all'},parameters:{amplitude:null,frequency:null,decay:null,durationSeconds:null,property:null,easing:null},amplitudeFactor:.25,frequencyFactor:.5,durationFactor:null}],assumptions:[]};
 const schema=z.union([incrementalEditSchema,semanticGraphSchema,intentPlanSchema]);
 for(const invalid of [false,true]){
  const output=structuredClone(wire);if(invalid)output.edits[0].effect='invented';
  const f=await fixture('strict-json-schema',output);
  try{
   const run=()=>f.client.structured({incrementalEditHint:true},'reduce logo amplitude and frequency','Return typed edits',schema,'semantic-planning',incrementalEditSchema);
   if(invalid)await assert.rejects(run,/INVALID_OUTPUT/);
   else{const parsed=await run();assert.ok('edits' in parsed);assert.equal(parsed.edits[0].amplitudeFactor,.25);assert.equal(parsed.edits[0].frequencyFactor,.5);assert.deepEqual(parsed.edits[0].parameters,{});assert.equal(parsed.edits[0].scope.sceneId,undefined);}
   assert.equal(f.calls(),1);
  }finally{await f.cleanup();}
 }
});

test("provider model identifiers accept namespaces and local tags without accepting endpoints or credentials", () => {
  for (const model of [
    "",
    "model-v1",
    "vendor/model-name",
    "model:8b",
    "vendor/model:Q4_K_M",
  ])
    assert.equal(providerSettingsSchema.parse({ model }).model, model);
  for (const model of [
    "https://host/model",
    " model",
    "model\nsecret",
    "/private/model",
    "sk-abcdef123456789012345678901234567890",
  ])
    assert.equal(providerSettingsSchema.safeParse({ model }).success, false);
});

async function fixture(
  dialect: ProviderCapabilities["schemaDialect"],
  output: unknown,
  structuredOutput = true,
  toolCalls: { name: string; arguments: unknown }[] = [],
) {
  const directory = await mkdtemp(path.join(tmpdir(), "provider-portability-"));
  let calls = 0;
  let request: ProviderRequest | undefined;
  const stop = registerProvider("portability-fixture", () => ({
    id: "portability-fixture",
    mode: "mock",
    capabilities: () => ({
      structuredOutput,
      schemaDialect: dialect,
      nativeToolCalling: false,
      cancellation: true,
      usage: false,
      nativeOutputTokenLimit: false,
    }),
    generate: async (input) => {
      calls++;
      request = input;
      return {
        output,
        usage: null,
        estimatedCost: null,
        latencyMs: 0,
        diagnostics: [],
        toolCalls,
      };
    },
  }));
  return {
    client: new AIClient(
      { provider: "portability-fixture", model: "vendor/model:8b" },
      directory,
    ),
    calls: () => calls,
    request: () => request,
    cleanup: async () => {
      stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
const contract = z
  .object({ name: z.string(), note: z.string().optional() })
  .strict();
test("plain JSON-schema adapter receives optional fields without Codex null expansion and remains runtime validated", async () => {
  const f = await fixture("json-schema", { name: "valid" });
  try {
    assert.deepEqual(
      await f.client.structured({}, "request", "instructions", contract),
      { name: "valid" },
    );
    assert.deepEqual(
      (f.request()!.responseSchema as { required: string[] }).required,
      ["name"],
    );
    assert.equal(f.request()!.model, "vendor/model:8b");
    assert.equal(f.calls(), 1);
  } finally {
    await f.cleanup();
  }
  const bad = await fixture("json-schema", { name: "valid", note: null });
  try {
    await assert.rejects(
      bad.client.structured({}, "request", "instructions", contract),
    );
    assert.equal(bad.calls(), 1);
  } finally {
    await bad.cleanup();
  }
});
test("legacy and strict adapters retain optional-null normalization", async () => {
  for (const dialect of [undefined, "strict-json-schema"] as const) {
    const f = await fixture(dialect, { name: "valid", note: null });
    try {
      assert.deepEqual(
        await f.client.structured({}, "request", "instructions", contract),
        { name: "valid" },
      );
      assert.deepEqual(
        (f.request()!.responseSchema as { required: string[] }).required,
        ["name", "note"],
      );
    } finally {
      await f.cleanup();
    }
  }
});
test("unsupported structured output fails before a call; unsolicited tools are rejected even without Harness runtime", async () => {
  const unsupported = await fixture("json-schema", {}, false);
  try {
    await assert.rejects(
      unsupported.client.structured({}, "request", "instructions", contract),
      /UNSUPPORTED_CAPABILITY/,
    );
    assert.equal(unsupported.calls(), 0);
  } finally {
    await unsupported.cleanup();
  }
  const tools = await fixture("json-schema", { name: "valid" }, true, [
    { name: "arbitrary", arguments: {} },
  ]);
  try {
    await assert.rejects(
      tools.client.structured({}, "request", "instructions", contract),
      /UNSUPPORTED_CAPABILITY/,
    );
    assert.equal(tools.calls(), 1);
  } finally {
    await tools.cleanup();
  }
});
