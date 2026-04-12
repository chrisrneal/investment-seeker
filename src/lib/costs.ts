// Per-million-token pricing (USD) for supported models.
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
};

/**
 * Estimate cost in USD from token counts and model name.
 * Cache reads are 90% cheaper than regular input tokens.
 */
export function estimateCost(params: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}): number {
  const pricing = MODEL_PRICING[params.model];
  if (!pricing) return 0;

  const { input, output } = pricing;
  const freshInput = params.inputTokens - (params.cacheReadTokens ?? 0) - (params.cacheCreationTokens ?? 0);

  const inputCost = (Math.max(freshInput, 0) * input) / 1_000_000;
  const outputCost = (params.outputTokens * output) / 1_000_000;
  // Cache reads cost 10% of normal input price.
  const cacheReadCost =
    ((params.cacheReadTokens ?? 0) * input * 0.1) / 1_000_000;
  // Cache creation costs 25% more than normal input price.
  const cacheCreationCost =
    ((params.cacheCreationTokens ?? 0) * input * 1.25) / 1_000_000;

  return inputCost + outputCost + cacheReadCost + cacheCreationCost;
}
