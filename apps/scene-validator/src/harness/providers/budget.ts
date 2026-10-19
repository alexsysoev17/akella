import {
  ProviderError,
  type ProviderAdapter,
  type ProviderRequest,
} from "./types.js";
export interface ModelProfile {
  provider: string;
  model: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  transportOverheadTokens: number;
}
export function providerBudget(
  adapter: ProviderAdapter,
  request: ProviderRequest,
  maxBytes: number,
  profiles: ModelProfile[] = [],
) {
  const components = {
    system: 0,
    user: 0,
    assistant: 0,
    schema: Buffer.byteLength(JSON.stringify(request.responseSchema)),
    tools: Buffer.byteLength(JSON.stringify(request.tools ?? [])),
  };
  for (const m of request.messages)
    components[m.role] += Buffer.byteLength(m.content);
  const totalBytes = Buffer.byteLength(
    JSON.stringify({
      messages: request.messages,
      responseSchema: request.responseSchema,
      tools: request.tools ?? [],
    }),
  );
  if (totalBytes > maxBytes)
    throw new ProviderError(
      "CONTEXT_EXHAUSTED",
      `Full request ${totalBytes} bytes exceeds ${maxBytes}; no content truncated`,
    );
  const profile = profiles.find(
    (p) => p.provider === adapter.id && p.model === (request.model ?? ""),
  );
  const measured = adapter.estimateInputTokens?.(request);
  if (
    measured !== undefined &&
    (!Number.isSafeInteger(measured) || measured < 0)
  )
    throw new ProviderError("INVALID_OUTPUT", "Invalid adapter token estimate");
  const inputTokens = measured ?? totalBytes;
  const outputTokens = Math.min(
    request.maxOutputTokens,
    profile?.maxOutputTokens ?? request.maxOutputTokens,
  );
  if (
    profile &&
    inputTokens + profile.transportOverheadTokens + outputTokens >
      profile.contextWindowTokens
  )
    throw new ProviderError(
      "CONTEXT_EXHAUSTED",
      `Model window ${profile.contextWindowTokens} cannot fit input ${inputTokens}, transport reserve ${profile.transportOverheadTokens} and output ${outputTokens}; no content truncated`,
    );
  return {
    components,
    totalBytes,
    inputTokens,
    estimateMethod:
      measured === undefined ? "conservative-byte-bound" : "adapter-tokenizer",
    profile: profile ?? null,
    outputTokens,
  };
}
