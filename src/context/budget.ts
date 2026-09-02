import type { LlmUsage, Message } from "../domain/messages.js";
import type { ContextUsage } from "../domain/context.js";
import type { LlmToolDefinition } from "../llm/provider.js";

export const DEFAULT_CONTEXT_WARNING_RATIO = 0.75;
export const DEFAULT_CONTEXT_STOP_RATIO = 0.9;
export const DEFAULT_CHARS_PER_TOKEN = 4;

export interface BudgetTrackerOptions {
  contextWindow: number;
  warningRatio?: number;
  stopRatio?: number;
  charsPerToken?: number;
}

export interface ContextBudgetDecision {
  allowed: boolean;
  ratio: number;
  estimatedTokens: number;
  usedFallbackEstimate: boolean;
  warning?: string;
}

function validateRatio(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`${label} must be between 0 and 1`);
  }
  return value;
}

export function estimateMessageCharacters(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total + JSON.stringify(message).length + 16, 0);
}

export function estimateToolCharacters(tools: readonly LlmToolDefinition[]): number {
  return tools.reduce((total, tool) => total + JSON.stringify(tool).length + 32, 0);
}

export class BudgetTracker {
  public readonly contextWindow: number;
  public readonly warningRatio: number;
  public readonly stopRatio: number;
  public readonly charsPerToken: number;

  private lastPromptTokens: number | undefined;
  private anchorCharacters = 0;
  private usageMissing = false;
  private thresholdWarningIssued = false;
  private fallbackWarningIssued = false;

  public constructor(options: BudgetTrackerOptions) {
    if (!Number.isSafeInteger(options.contextWindow) || options.contextWindow <= 0) {
      throw new Error("contextWindow must be a positive integer");
    }
    this.contextWindow = options.contextWindow;
    this.warningRatio = validateRatio(options.warningRatio ?? DEFAULT_CONTEXT_WARNING_RATIO, "warningRatio");
    this.stopRatio = validateRatio(options.stopRatio ?? DEFAULT_CONTEXT_STOP_RATIO, "stopRatio");
    if (this.warningRatio >= this.stopRatio) {
      throw new Error("warningRatio must be lower than stopRatio");
    }
    this.charsPerToken = options.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
    if (!Number.isFinite(this.charsPerToken) || this.charsPerToken <= 0) {
      throw new Error("charsPerToken must be positive");
    }
  }

  public recordUsage(usage: LlmUsage, messages: readonly Message[], tools: readonly LlmToolDefinition[] = []): void {
    if (!Number.isSafeInteger(usage.promptTokens) || usage.promptTokens < 0) {
      this.recordMissingUsage();
      return;
    }
    this.lastPromptTokens = usage.promptTokens;
    this.anchorCharacters = estimateMessageCharacters(messages) + estimateToolCharacters(tools);
    this.usageMissing = false;
  }

  public recordMissingUsage(): void {
    this.lastPromptTokens = undefined;
    this.anchorCharacters = 0;
    this.usageMissing = true;
  }

  public reset(): void {
    this.lastPromptTokens = undefined;
    this.anchorCharacters = 0;
    this.usageMissing = false;
    this.thresholdWarningIssued = false;
    this.fallbackWarningIssued = false;
  }

  public beforeRequest(
    messages: readonly Message[],
    tools: readonly LlmToolDefinition[] = []
  ): ContextBudgetDecision {
    const currentUsage = this.measureCurrent(messages, tools);
    const usedFallbackEstimate = currentUsage.source === "fallback_estimate";
    const { estimatedTokens, ratio } = currentUsage;
    const warningParts: string[] = [];

    if (usedFallbackEstimate && !this.fallbackWarningIssued) {
      this.fallbackWarningIssued = true;
      warningParts.push("Prompt usage was unavailable; using a conservative character estimate.");
    }
    if (ratio >= this.warningRatio && !this.thresholdWarningIssued) {
      this.thresholdWarningIssued = true;
      warningParts.push(`Estimated context usage reached ${Math.round(ratio * 100)}% of the configured window.`);
    }

    return {
      allowed: ratio < this.stopRatio,
      ratio,
      estimatedTokens,
      usedFallbackEstimate,
      ...(warningParts.length === 0 ? {} : { warning: warningParts.join(" ") })
    };
  }

  public measureCurrent(
    messages: readonly Message[],
    tools: readonly LlmToolDefinition[] = []
  ): ContextUsage {
    const currentCharacters = estimateMessageCharacters(messages) + estimateToolCharacters(tools);
    const anchoredPromptTokens = this.lastPromptTokens;
    if (anchoredPromptTokens === undefined) {
      return this.measureFallbackEstimate(currentCharacters);
    }
    const estimatedTokens = anchoredPromptTokens + Math.ceil(
      Math.max(0, currentCharacters - this.anchorCharacters) / this.charsPerToken
    );
    return {
      estimatedTokens,
      ratio: estimatedTokens / this.contextWindow,
      contextWindow: this.contextWindow,
      source: "usage_anchor"
    };
  }

  public measureFallback(
    messages: readonly Message[],
    tools: readonly LlmToolDefinition[] = []
  ): ContextUsage {
    return this.measureFallbackEstimate(estimateMessageCharacters(messages) + estimateToolCharacters(tools));
  }

  public getLastPromptTokens(): number | undefined {
    return this.lastPromptTokens;
  }

  public isUsageMissing(): boolean {
    return this.usageMissing;
  }

  private measureFallbackEstimate(currentCharacters: number): ContextUsage {
    const estimatedTokens = Math.ceil(currentCharacters / this.charsPerToken);
    return {
      estimatedTokens,
      ratio: estimatedTokens / this.contextWindow,
      contextWindow: this.contextWindow,
      source: "fallback_estimate"
    };
  }
}
