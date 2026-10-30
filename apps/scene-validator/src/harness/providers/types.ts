import { PROVIDER_ID_PATTERN } from "../../provider-contract.js";
export interface ProviderCapabilities {
  /** Adapter can return parsed JSON; native enforcement is not required. */
  structuredOutput: boolean;
  /** Omission preserves historical Codex-compatible wire schemas. */
  schemaDialect?: "strict-json-schema" | "json-schema";
  nativeToolCalling: boolean;
  cancellation: boolean;
  usage: boolean;
  nativeOutputTokenLimit: boolean;
}
export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}
export interface ProviderRequest {
  purpose?: "semantic-planning" | "semantic-repair" | "semantic-recovery" | "project-recovery" | "code-repair" | "motion-repair";
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  responseSchema: unknown;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputTokens: number;
  tools?: { name: string; description: string; parameters: unknown }[];
}
export interface ProviderResponse {
  /** Assigned by Harness, never by the model. */
  callIndex?: number;
  output: unknown;
  usage: ProviderUsage | null;
  estimatedCost: number | null;
  latencyMs: number;
  diagnostics: string[];
  toolCalls: { name: string; arguments: unknown }[];
}
export interface ProviderHealth {
  status: "READY" | "UNAVAILABLE" | "AUTH_REQUIRED" | "UNKNOWN";
  message: string;
}
export interface ProviderAdapter {
  readonly id: string;
  readonly mode: "live" | "mock";
  capabilities(): ProviderCapabilities;
  health?(): Promise<ProviderHealth>;
  estimateInputTokens?(request: ProviderRequest): number;
  contextProfile?(model?:string):Promise<{provider:string;model:string;contextWindowTokens:number;maxOutputTokens:number;transportOverheadTokens:number;reasoningReserveTokens?:number;source?:string}|undefined>;
  generate(request: ProviderRequest): Promise<ProviderResponse>;
}
export class ProviderError extends Error {
  constructor(
    public code:
      | "UNAVAILABLE"
      | "UNSUPPORTED_CAPABILITY"
      | "TIMEOUT"
      | "CANCELLED"
      | "INVALID_OUTPUT"
      | "OUTPUT_TRUNCATED"
      | "TRANSPORT"
      | "AUTH_REQUIRED"
      | "RATE_LIMITED"
      | "OVERLOADED"
      | "CONTEXT_EXHAUSTED"
      | "PROVIDER_SCHEMA_INVALID"
      | "PROVIDER_UNAVAILABLE"
      | "PROVIDER_AUTH_FAILED"
      | "PROVIDER_TIMEOUT"
      | "PROVIDER_TRANSPORT_ERROR"
      | "PROVIDER_EVENT_PARSE_ERROR"
      | "PROVIDER_JSON_INVALID",
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}
const factories = new Map<string, (directory: string) => ProviderAdapter>();
export function registerProvider(
  id: string,
  factory: (directory: string) => ProviderAdapter,
) {
  if (!PROVIDER_ID_PATTERN.test(id)) throw new Error("Invalid provider ID");
  const previous = factories.get(id);
  factories.set(id, factory);
  return () => {
    if (factories.get(id) !== factory) return;
    if (previous) factories.set(id, previous);
    else factories.delete(id);
  };
}
export function registeredProvider(id: string, directory: string) {
  const factory = factories.get(id);
  if (!factory)
    throw new ProviderError("UNAVAILABLE", `Adapter ${id} is not registered`);
  const adapter = factory(directory);
  if (adapter.id !== id)
    throw new ProviderError("INVALID_OUTPUT", "Registered adapter ID mismatch");
  return adapter;
}
export function providerIds() {
  return [...factories.keys()];
}

/** HTTP-compatible adapters retain actionable transport categories without retrying blindly. */
export function transportErrorCode(error: unknown): ProviderError["code"] {
  const message = String(error);
  if (/max_output_tokens|incomplete.*(?:output|response)|finish_reason.{0,15}length/i.test(message)) return "OUTPUT_TRUNCATED";
  if (/invalid_json_schema|invalid.*(?:output|response).*schema|schema must be.*object/i.test(message)) return "PROVIDER_SCHEMA_INVALID";
  if (/401|403|unauthori[sz]ed|authentication|not logged in/i.test(message)) return "PROVIDER_AUTH_FAILED";
  if (/ENOENT|ECONNREFUSED|ENOTFOUND/.test(message)) return "PROVIDER_UNAVAILABLE";
  const e =
    error && typeof error === "object"
      ? (error as { status?: number; statusCode?: number; code?: string })
      : {};
  if (
    ["context_length_exceeded", "context_window_exceeded"].includes(
      e.code ?? "",
    )
  )
    return "CONTEXT_EXHAUSTED";
  const status = e.status ?? e.statusCode;
  if (status === 401 || status === 403) return "AUTH_REQUIRED";
  if (status === 429) return "RATE_LIMITED";
  if (status === 503) return "OVERLOADED";
  if (status === 408 || status === 504) return "TIMEOUT";
  return "TRANSPORT";
}

/** DOM AbortSignal deadlines have numeric .code; do not mistake that for validation. */
export function providerAbortCode(error:unknown): 'PROVIDER_TIMEOUT'|'CANCELLED'|undefined {
 const e=error as {name?:string;message?:string};
 return e?.name==='TimeoutError'?'PROVIDER_TIMEOUT':e?.name==='AbortError'?'CANCELLED':undefined;
}
