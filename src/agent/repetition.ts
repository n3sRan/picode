import type { ToolCall } from "../domain/messages.js";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])])
    );
  }
  return value;
}

export function stableSerialize(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function toolSignature(call: Pick<ToolCall, "name" | "arguments">): string {
  return `${call.name}:${stableSerialize(call.arguments)}`;
}

export interface RepetitionCheck {
  signature: string;
  count: number;
  exceedsLimit: boolean;
}

export class RepetitionTracker {
  private lastSignature: string | undefined;
  private repeatCount = 0;

  public constructor(private readonly maxConsecutiveCalls = 3) {
    if (!Number.isSafeInteger(maxConsecutiveCalls) || maxConsecutiveCalls < 2) {
      throw new Error("maxConsecutiveCalls must be an integer of at least 2");
    }
  }

  public preview(call: Pick<ToolCall, "name" | "arguments">): RepetitionCheck {
    const signature = toolSignature(call);
    const count = signature === this.lastSignature ? this.repeatCount + 1 : 1;
    return { signature, count, exceedsLimit: count >= this.maxConsecutiveCalls };
  }

  public previewBatch(calls: readonly Pick<ToolCall, "name" | "arguments">[]): RepetitionCheck | undefined {
    let lastSignature = this.lastSignature;
    let count = this.repeatCount;
    for (const call of calls) {
      const signature = toolSignature(call);
      count = signature === lastSignature ? count + 1 : 1;
      if (count >= this.maxConsecutiveCalls) {
        return { signature, count, exceedsLimit: true };
      }
      lastSignature = signature;
    }
    return undefined;
  }

  public commit(call: Pick<ToolCall, "name" | "arguments">): void {
    const check = this.preview(call);
    this.lastSignature = check.signature;
    this.repeatCount = check.count;
  }

  public commitBatch(calls: readonly Pick<ToolCall, "name" | "arguments">[]): void {
    for (const call of calls) {
      this.commit(call);
    }
  }

  public snapshot(): { signature?: string; count: number } {
    return {
      ...(this.lastSignature === undefined ? {} : { signature: this.lastSignature }),
      count: this.repeatCount
    };
  }
}
