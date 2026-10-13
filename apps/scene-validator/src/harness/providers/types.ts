export interface ProviderCapabilities {
  structuredOutput: boolean;
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
  purpose?: "semantic-planning" | "semantic-repair" | "motion-repair";
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  responseSchema: unknown;
  model?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputTokens: number;
  tools?: { name: string; description: string; parameters: unknown }[];
}
export interface ProviderResponse {
  output: unknown;
  usage: ProviderUsage | null;
  estimatedCost: number | null;
  latencyMs: number;
  diagnostics: string[];
  toolCalls: { name: string; arguments: unknown }[];
}
export interface ProviderAdapter {
  readonly id: string;
  readonly mode: "live" | "mock";
  capabilities(): ProviderCapabilities;
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
      | "TRANSPORT",
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
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id))
    throw new Error("Invalid provider ID");
  factories.set(id, factory);
  return () => factories.delete(id);
}
export function registeredProvider(id: string, directory: string) {
  const factory = factories.get(id);
  if (!factory)
    throw new ProviderError("UNAVAILABLE", `Adapter ${id} is not registered`);
  return factory(directory);
}
export function providerIds() {
  return [...factories.keys()];
}
