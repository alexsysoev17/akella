import { packContext, unpackContext, contextEncodingInstructions } from "../context-packing.js";
import { ProviderError, type ProviderAdapter, type ProviderRequest, } from "./types.js";
export interface ModelProfile {
    provider: string;
    model: string;
    contextWindowTokens: number;
    maxOutputTokens: number;
    transportOverheadTokens: number;
    reasoningReserveTokens?:number;
    source?:string;
}
/** Runtime signals are process objects; every serialized provider field is charged. */
export function serializedRequestBytes(request: ProviderRequest) {
    const { signal, ...payload } = request;
    return Buffer.byteLength(JSON.stringify({ ...payload, tools: request.tools ?? [] }));
}
/** Byte accounting only; no token counts are fabricated from characters. */
export function requestContextCategories(request: Pick<ProviderRequest,"messages"|"responseSchema">) {
    const categories = {userIntent:0,projectSnapshot:0,objectContext:0,motionGraph:0,conversationHistory:0,skills:0,schema:Buffer.byteLength(JSON.stringify(request.responseSchema)??"null"),systemInstructions:0,other:0};
    const fieldBytes:Record<string,number>={};
    const bytes=(v:unknown)=>Buffer.byteLength(JSON.stringify(v)??"null");
    for(const m of request.messages) {
        if(m.role==="system"){categories.systemInstructions+=Buffer.byteLength(m.content);continue;}
        let p;try{p=JSON.parse(m.content);}catch{categories.other+=Buffer.byteLength(m.content);continue;}
        if(p.userRequest)categories.userIntent+=bytes(p.userRequest);
        for(const [key,value] of Object.entries(unpackContext(p.context) as object??{})) {
            const category=key==="userRequest"?"userIntent":/objectIndex|logicalObjects|selectedObject|mentions/.test(key)?"objectContext":/motion$|effectState|Inventory|motionRules/.test(key)?"motionGraph":/Conversation|History|SuccessfulActions/.test(key)?"conversationHistory":/Knowledge|skill|capabilit/i.test(key)?"skills":/project|sceneIndex|timing/i.test(key)?"projectSnapshot":"other";
            categories[category]+=bytes(value);if(category==='other')fieldBytes[key]=(fieldBytes[key]??0)+bytes(value);
        }
    }
    return {...categories,otherFields:fieldBytes,accounting:"semantic values after lossless decoding; serialized totalBytes and message components are actual wire bytes"};
}
export function providerBudget(adapter: ProviderAdapter, request: ProviderRequest, maxBytes: number, profiles: ModelProfile[] = []) {
    const components = {
        system: 0,
        user: 0,
        assistant: 0,
        schema: Buffer.byteLength(JSON.stringify(request.responseSchema)),
        tools: Buffer.byteLength(JSON.stringify(request.tools ?? [])),
    };
    for (const m of request.messages)
        components[m.role] += Buffer.byteLength(m.content);
    const totalBytes = serializedRequestBytes(request);
    if (totalBytes > maxBytes)
        throw new ProviderError("CONTEXT_EXHAUSTED", `Full request ${totalBytes} bytes exceeds ${maxBytes}; no content truncated`);
    const configured = profiles.find((p) => p.provider === adapter.id && p.model === (request.model ?? ""));
    const profile:ModelProfile = configured??{provider:adapter.id,model:request.model??"",contextWindowTokens:128000,maxOutputTokens:16000,transportOverheadTokens:8192,reasoningReserveTokens:8192,source:"UNKNOWN_MODEL_CONSERVATIVE_PROFILE: configure an exact model profile or adapter discovery"};
    const measured = adapter.estimateInputTokens?.(request);
    if (measured !== undefined &&
        (!Number.isSafeInteger(measured) || measured < 0))
        throw new ProviderError("INVALID_OUTPUT", "Invalid adapter token estimate");
    const estimate=(text:string)=>{const ascii=(text.match(/[\x00-\x7f]/g)??[]).length;return Math.ceil((ascii/2+Buffer.byteLength(text.replace(/[\x00-\x7f]/g,'')))*1.25);};
    const inputTokens = measured ?? estimate(JSON.stringify({...request,signal:undefined}))+request.messages.length*8;
    const outputTokens = Math.min(request.maxOutputTokens, profile?.maxOutputTokens ?? request.maxOutputTokens);
    if (profile &&
        inputTokens + profile.transportOverheadTokens + (profile.reasoningReserveTokens??0) + outputTokens >
            profile.contextWindowTokens)
        throw new ProviderError("CONTEXT_EXHAUSTED", `Model window ${profile.contextWindowTokens} cannot fit input ${inputTokens}, transport reserve ${profile.transportOverheadTokens} and output ${outputTokens}; no content truncated`);
    return {
        components,
        totalBytes,
        inputTokens,
        estimateMethod: measured === undefined ? "unicode-aware-estimate-25pct-margin-NOT_MEASURED" : "adapter-tokenizer",
        tokenCountIsExact:false,
        componentTokenEstimates:Object.fromEntries(Object.entries(components).map(([key,n])=>[key,Math.ceil(n*.625)])),
        profileStatus:configured?"RESOLVED":"UNKNOWN_MODEL_CONSERVATIVE",
        reasoningReserveTokens:profile.reasoningReserveTokens??0,
        actualUsage:"AVAILABLE_ONLY_AFTER_PROVIDER_RESPONSE",
        profile: profile ?? null,
        outputTokens,
    };
}
/** Try a lossless context encoding before rejecting. Never spends a provider call. */
export function prepareProviderRequest(adapter: ProviderAdapter, request: ProviderRequest, maxBytes: number, profiles: ModelProfile[] = []) {
    const beforeBytes = serializedRequestBytes(request);
    const mandatoryBytes=request.messages.reduce((sum,m)=>{if(m.role!=="user")return sum+Buffer.byteLength(m.content);try{const p=JSON.parse(m.content);return sum+Buffer.byteLength(typeof p.userRequest==="string"?p.userRequest:m.content);}catch{return sum+Buffer.byteLength(m.content);}},0)+Buffer.byteLength(JSON.stringify(request.responseSchema))+Buffer.byteLength(JSON.stringify(request.tools??[]));
    const report = { modelBudget:null as ReturnType<typeof providerBudget>|null, categories:requestContextCategories(request), mandatoryBytes,version: "context-admission/1", beforeBytes, afterBytes: beforeBytes, budgetBytes: maxBytes, compactedCategories: [] as string[], lossless: true, promptPreserved: true, instructionsPreserved: true, schemaPreserved: true, requirementCount: null as number | null, requirementCountStatus: "NOT_PLANNED", llmCalls: 0, status: "ADMITTED", reason: null as string | null };
    let initial: unknown;
    try {
        const budget=providerBudget(adapter, request, maxBytes, profiles);report.modelBudget=budget;return { request, budget, report };
    }
    catch (error) {
        if (!(error instanceof ProviderError) || error.code !== "CONTEXT_EXHAUSTED")
            throw error;
        initial = error;
    }
    let candidate = request;
    if (request.purpose?.startsWith("semantic")) {
        const categories = new Set<string>();
        let changed = false;
        const messages = request.messages.map(message => {
            if (message.role !== "user")
                return message;
            let payload;
            try {
                payload = JSON.parse(message.content);
            }
            catch {
                return message;
            }
            if (!payload || typeof payload !== "object" || typeof payload.userRequest !== "string" || !payload.context || typeof payload.context !== "object")
                return message;
            const packed = packContext(payload.context);
            if (packed.packedBytes >= packed.originalBytes)
                return message;
            packed.changedCategories.forEach(k => categories.add(k));
            changed = true;
            return { ...message, content: JSON.stringify({ ...payload, context: packed.value }) };
        });
        if (changed) {
            const system = messages.findIndex(m => m.role === "system");
            if (system >= 0)
                messages[system] = { ...messages[system], content: messages[system].content + contextEncodingInstructions };
            else
                messages.unshift({ role: "system", content: contextEncodingInstructions });
            candidate = { ...request, messages };
            if (serializedRequestBytes(candidate) >= beforeBytes)
                candidate = request;
            else
                report.compactedCategories = [...categories];
        }
    }
    report.afterBytes = serializedRequestBytes(candidate);
    report.categories=requestContextCategories(candidate);
    try {
        const budget=providerBudget(adapter,candidate,maxBytes,profiles);report.modelBudget=budget;return {request:candidate,budget,report};
    }
    catch (error) {
        if (!(error instanceof ProviderError) || error.code !== "CONTEXT_EXHAUSTED")
            throw error;
        report.status = "REJECTED";
        report.reason = report.afterBytes <= maxBytes ? "MODEL_WINDOW_EXHAUSTED" : report.compactedCategories.length ? "LOSSLESS_CONTEXT_STILL_EXCEEDS_BUDGET" : "MANDATORY_REQUEST_EXCEEDS_BUDGET";
        throw Object.assign(new ProviderError("CONTEXT_EXHAUSTED", `${report.reason}: ${report.afterBytes} bytes after safe packing (${beforeBytes} before), budget ${maxBytes}. User prompt, system instructions, schema and context values preserved; provider not called. ${error.message}`), { contextAdmission: report, cause: initial });
    }
}
