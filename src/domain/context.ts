export type ContextUsageSource = "usage_anchor" | "fallback_estimate";

export interface ContextUsage {
  estimatedTokens: number;
  ratio: number;
  contextWindow: number;
  source: ContextUsageSource;
}
