import type { ToolExecutionStatus } from "../tools/types.js";

export const DEFAULT_MAX_LLM_REQUESTS = 20;
export const DEFAULT_MAX_ACTIVE_MS = 10 * 60 * 1_000;
export const DEFAULT_MAX_CONSECUTIVE_TOOL_ERRORS = 3;
export const DEFAULT_MAX_NO_FINISH_TURNS = 3;

export interface AgentLimitOptions {
  maxLlmRequests?: number;
  maxActiveMs?: number;
  maxConsecutiveToolErrors?: number;
  maxNoFinishTurns?: number;
}

export interface LimitSnapshot {
  llmRequestCount: number;
  activeElapsedMs: number;
  consecutiveToolErrors: number;
  consecutiveNoFinishTurns: number;
}

export type LimitViolation =
  | "llm_request_limit"
  | "active_time_limit"
  | "tool_error_limit"
  | "no_finish_limit";

export interface MonotonicClock {
  now(): number;
}

export const systemMonotonicClock: MonotonicClock = {
  now: () => performance.now()
};

/** Tracks active work and supports pausing while an approval prompt is open. */
export class ActiveTimeTracker {
  private accumulatedMs = 0;
  private runningSince: number | undefined;

  public constructor(private readonly clock: MonotonicClock = systemMonotonicClock) {}

  public start(): void {
    if (this.runningSince === undefined) {
      this.runningSince = this.clock.now();
    }
  }

  public pause(): void {
    if (this.runningSince === undefined) {
      return;
    }
    this.accumulatedMs += Math.max(0, this.clock.now() - this.runningSince);
    this.runningSince = undefined;
  }

  public resume(): void {
    this.start();
  }

  public elapsedMs(): number {
    if (this.runningSince === undefined) {
      return this.accumulatedMs;
    }
    return this.accumulatedMs + Math.max(0, this.clock.now() - this.runningSince);
  }
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return resolved;
}

export class TaskLimitTracker {
  public readonly maxLlmRequests: number;
  public readonly maxActiveMs: number;
  public readonly maxConsecutiveToolErrors: number;
  public readonly maxNoFinishTurns: number;

  private llmRequestCount = 0;
  private consecutiveToolErrors = 0;
  private consecutiveNoFinishTurns = 0;

  public constructor(options: AgentLimitOptions = {}) {
    this.maxLlmRequests = positiveInteger(options.maxLlmRequests, DEFAULT_MAX_LLM_REQUESTS, "maxLlmRequests");
    this.maxActiveMs = positiveInteger(options.maxActiveMs, DEFAULT_MAX_ACTIVE_MS, "maxActiveMs");
    this.maxConsecutiveToolErrors = positiveInteger(
      options.maxConsecutiveToolErrors,
      DEFAULT_MAX_CONSECUTIVE_TOOL_ERRORS,
      "maxConsecutiveToolErrors"
    );
    this.maxNoFinishTurns = positiveInteger(options.maxNoFinishTurns, DEFAULT_MAX_NO_FINISH_TURNS, "maxNoFinishTurns");
  }

  public checkBeforeRequest(activeElapsedMs: number): LimitViolation | undefined {
    if (this.llmRequestCount >= this.maxLlmRequests) {
      return "llm_request_limit";
    }
    if (activeElapsedMs >= this.maxActiveMs) {
      return "active_time_limit";
    }
    return undefined;
  }

  public recordLlmRequest(): void {
    this.llmRequestCount += 1;
  }

  public recordTextOnlyTurn(): LimitViolation | undefined {
    this.consecutiveNoFinishTurns += 1;
    return this.consecutiveNoFinishTurns >= this.maxNoFinishTurns ? "no_finish_limit" : undefined;
  }

  public recordToolTurn(): void {
    this.consecutiveNoFinishTurns = 0;
  }

  public recordToolResult(
    status: ToolExecutionStatus,
    options: { approvalDenied?: boolean } = {}
  ): LimitViolation | undefined {
    if (status === "ok") {
      this.consecutiveToolErrors = 0;
      return undefined;
    }
    if (status === "batch_rejected" || (status === "permission_denied" && options.approvalDenied === true)) {
      return undefined;
    }
    this.consecutiveToolErrors += 1;
    return this.consecutiveToolErrors >= this.maxConsecutiveToolErrors ? "tool_error_limit" : undefined;
  }

  public snapshot(activeElapsedMs: number): LimitSnapshot {
    return {
      llmRequestCount: this.llmRequestCount,
      activeElapsedMs,
      consecutiveToolErrors: this.consecutiveToolErrors,
      consecutiveNoFinishTurns: this.consecutiveNoFinishTurns
    };
  }
}

export function limitViolationMessage(violation: LimitViolation): string {
  switch (violation) {
    case "llm_request_limit":
      return "The maximum number of LLM requests for this task has been reached.";
    case "active_time_limit":
      return "The maximum active time for this task has been reached.";
    case "tool_error_limit":
      return "The task stopped after three consecutive tool errors.";
    case "no_finish_limit":
      return "The model did not call finish after three consecutive text-only turns.";
  }
}
