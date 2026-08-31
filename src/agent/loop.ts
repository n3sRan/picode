import type { AgentEvent } from "../domain/events.js";
import type {
  AssistantMessage,
  JsonObject,
  LlmUsage,
  Message,
  ToolCall,
  ToolResultMessage,
  UserMessage
} from "../domain/messages.js";
import type { AgentState, TerminalState, TerminationReason } from "../domain/state.js";
import { LlmProviderError, normalizeLlmProviderError } from "../domain/errors.js";
import type { LlmProvider } from "../llm/provider.js";
import type { ApprovalBroker, ApprovalRequest } from "../security/approval.js";
import { redactSecrets } from "../security/redact.js";
import { BudgetTracker, type ContextBudgetDecision } from "../context/budget.js";
import {
  ActiveTimeTracker,
  DEFAULT_MAX_ACTIVE_MS,
  DEFAULT_MAX_CONSECUTIVE_TOOL_ERRORS,
  DEFAULT_MAX_LLM_REQUESTS,
  DEFAULT_MAX_NO_FINISH_TURNS,
  limitViolationMessage,
  systemMonotonicClock,
  TaskLimitTracker,
  type AgentLimitOptions,
  type LimitSnapshot,
  type MonotonicClock
} from "./limits.js";
import { RepetitionTracker, type RepetitionCheck } from "./repetition.js";
import { normalizeFinishArgs, type FinishArgs, type ResolvedFinishArgs } from "../tools/finish.js";
import { DEFAULT_SYSTEM_MESSAGE } from "./prompt.js";
import { ToolRegistry } from "../tools/registry.js";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionStatus,
  ToolResult
} from "../tools/types.js";
import { formatValidationIssues } from "../tools/validators.js";

export const PROTOCOL_REMINDER =
  "Protocol reminder: do not end this task with text alone. If the task is complete, call finish now; otherwise use the provided tools.";

export type AgentEventListener = (event: AgentEvent) => void;

export interface AgentLoopOptions {
  provider: LlmProvider;
  tools: ToolRegistry;
  toolContext: ToolExecutionContext;
  systemMessage?: string;
  initialMessages?: readonly Message[];
  limits?: AgentLimitOptions;
  maxConsecutiveRepeatedToolCalls?: number;
  contextWindow?: number;
  budgetTracker?: BudgetTracker;
  clock?: MonotonicClock;
  onEvent?: AgentEventListener;
  beforeToolExecution?: (call: ToolCall, checkpoint: ToolExecutionCheckpoint) => void | Promise<void>;
  afterToolExecution?: (
    call: ToolCall,
    result: ToolResult,
    checkpoint: ToolExecutionCheckpoint
  ) => void | Promise<void>;
}

export interface AgentRunResult {
  terminalState: TerminalState;
  state: TerminalState;
  reason: TerminationReason;
  message: string;
  messages: readonly Message[];
  events: readonly AgentEvent[];
  limits: LimitSnapshot;
  usage?: LlmUsage;
  finish?: ResolvedFinishArgs;
}

export class AgentLoopBusyError extends Error {
  public readonly name = "AgentLoopBusyError";
}

interface ValidatedToolCall {
  index: number;
  call: ToolCall;
  definition: ToolDefinition<any>;
  args: unknown;
}

interface BatchValidation {
  validEntries: readonly ValidatedToolCall[];
  issues: ReadonlyMap<number, string>;
  repetitionViolation?: RepetitionCheck;
}

export interface ToolExecutionCheckpoint {
  messages: readonly Message[];
  usage?: LlmUsage;
  limits: LimitSnapshot;
}

class LoopApprovalBroker implements ApprovalBroker {
  public constructor(
    private readonly delegate: ApprovalBroker,
    private readonly onStart: (request: ApprovalRequest) => void,
    private readonly onFinish: (approved: boolean) => void
  ) {}

  public async requestApproval(request: ApprovalRequest, signal?: AbortSignal): Promise<boolean> {
    this.onStart(request);
    let approved = false;
    try {
      approved = await this.delegate.requestApproval(request, signal);
      return approved;
    } finally {
      this.onFinish(approved);
    }
  }
}

function isToolExecutionStatus(value: unknown): value is ToolExecutionStatus {
  return [
    "ok",
    "error",
    "permission_denied",
    "aborted",
    "timeout",
    "interrupted",
    "batch_rejected"
  ].includes(value as ToolExecutionStatus);
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof LlmProviderError) {
    return error.message;
  }
  return error instanceof Error ? error.message : "Tool execution failed.";
}

function redactJsonValue(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") {
    return redact(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item, redact));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [redact(key), redactJsonValue(item, redact)])
    );
  }
  return value;
}

function safeToolCall(call: ToolCall, redact: (text: string) => string): ToolCall {
  const safeArguments = redactJsonValue(call.arguments, redact) as JsonObject;
  return {
    ...call,
    rawArguments: JSON.stringify(safeArguments),
    arguments: safeArguments
  };
}

function safeAssistantMessage(message: AssistantMessage, redact: (text: string) => string): AssistantMessage {
  return {
    ...message,
    content: redact(message.content),
    toolCalls: message.toolCalls.map((call) => safeToolCall(call, redact))
  };
}

function finishTerminalState(status: FinishArgs["status"]): {
  state: TerminalState;
  reason: TerminationReason;
} {
  switch (status) {
    case "success":
      return { state: "completed", reason: "finish_success" };
    case "partial":
      return { state: "partial", reason: "finish_partial" };
    case "failure":
      return { state: "failed", reason: "finish_failure" };
  }
}

export class AgentLoop {
  private readonly provider: LlmProvider;
  private readonly tools: ToolRegistry;
  private readonly baseToolContext: ToolExecutionContext;
  private readonly systemMessage: string;
  private readonly initialMessages: readonly Message[];
  private readonly limitOptions: AgentLimitOptions;
  private readonly maxConsecutiveRepeatedToolCalls: number;
  private readonly onEvent: AgentEventListener | undefined;
  private readonly clock: MonotonicClock;
  private readonly budget: BudgetTracker;
  private readonly beforeToolExecution: AgentLoopOptions["beforeToolExecution"];
  private readonly afterToolExecution: AgentLoopOptions["afterToolExecution"];
  private state: AgentState = "idle";
  private running = false;
  private messages: Message[] = [];
  private events: AgentEvent[] = [];
  private limits = new TaskLimitTracker();
  private activeTime: ActiveTimeTracker;
  private repetition = new RepetitionTracker();
  private finishArgs: ResolvedFinishArgs | undefined;
  private lastUsage: LlmUsage | undefined;
  private executionContext: ToolExecutionContext;

  public constructor(options: AgentLoopOptions) {
    this.provider = options.provider;
    this.tools = options.tools;
    this.baseToolContext = options.toolContext;
    this.systemMessage = options.systemMessage ?? DEFAULT_SYSTEM_MESSAGE;
    this.initialMessages = options.initialMessages ?? [];
    this.limitOptions = options.limits ?? {};
    this.maxConsecutiveRepeatedToolCalls = options.maxConsecutiveRepeatedToolCalls ?? 3;
    this.onEvent = options.onEvent;
    this.clock = options.clock ?? systemMonotonicClock;
    this.budget = options.budgetTracker ?? new BudgetTracker({ contextWindow: options.contextWindow ?? 128_000 });
    this.beforeToolExecution = options.beforeToolExecution;
    this.afterToolExecution = options.afterToolExecution;
    this.activeTime = new ActiveTimeTracker(this.clock);
    this.executionContext = this.baseToolContext;
  }

  public getState(): AgentState {
    return this.state;
  }

  public getMessages(): readonly Message[] {
    return [...this.messages];
  }

  public async run(userTask: string, signal?: AbortSignal): Promise<AgentRunResult> {
    if (this.running) {
      throw new AgentLoopBusyError("Agent loop is already running");
    }
    this.running = true;
    this.state = "idle";
    this.events = [];
    this.finishArgs = undefined;
    this.lastUsage = undefined;
    this.budget.reset();
    this.limits = new TaskLimitTracker(this.limitOptions);
    this.activeTime = new ActiveTimeTracker(this.clock);
    this.repetition = new RepetitionTracker(this.maxConsecutiveRepeatedToolCalls);
    this.messages = [...this.initialMessages];
    if (!this.messages.some((message) => message.role === "system" && message.content === this.systemMessage)) {
      this.messages.unshift({ role: "system", content: this.systemMessage });
    }
    const userMessage: UserMessage = { role: "user", content: userTask };
    this.messages.push(userMessage);
    this.executionContext = {
      ...this.baseToolContext,
      approvalBroker: new LoopApprovalBroker(
        this.baseToolContext.approvalBroker,
        (request) => this.beginApproval(request),
        (approved) => this.endApproval(approved)
      )
    };
    const taskSignal = signal ?? new AbortController().signal;
    this.activeTime.start();
    try {
      return await this.runLoop(taskSignal);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Agent loop failed unexpectedly.";
      return this.terminate("failed", "provider_error", message);
    } finally {
      this.running = false;
    }
  }

  private async runLoop(signal: AbortSignal): Promise<AgentRunResult> {
    const toolDefinitions = this.tools.toLlmDefinitions();
    while (true) {
      if (signal.aborted) {
        return this.terminateWithSkippedTools("aborted", "aborted", "The task was aborted by the user.", []);
      }

      this.setState("preparing_context");
      const limitViolation = this.limits.checkBeforeRequest(this.activeTime.elapsedMs());
      if (limitViolation !== undefined) {
        return this.terminate("limit_reached", "limit_reached", limitViolationMessage(limitViolation));
      }

      const budgetDecision = this.budget.beforeRequest(this.messages, toolDefinitions);
      this.emitBudgetWarning(budgetDecision);
      if (!budgetDecision.allowed) {
        return this.terminate(
          "limit_reached",
          "limit_reached",
          "The context budget reached the configured stop threshold."
        );
      }

      this.limits.recordLlmRequest();
      this.setState("streaming");
      let observedUsage: LlmUsage | undefined;
      let response;
      try {
        response = await this.provider.complete(
          {
            messages: this.messages,
            tools: toolDefinitions,
            signal
          },
          {
            onTextDelta: (delta) => this.emit({ type: "assistant_text_delta", delta: this.redact(delta) }),
            onUsage: (usage) => {
              observedUsage = usage;
              this.emit({ type: "llm_usage_received", usage });
            }
          }
        );
      } catch (error) {
        return this.handleProviderError(error, signal);
      }

      const promptMessages = [...this.messages];
      const assistantMessage = response.message;
      const safeAssistant = safeAssistantMessage(assistantMessage, (value) => this.redact(value));
      this.messages.push(safeAssistant);
      this.emit({
        type: "assistant_message_completed",
        message: safeAssistant
      });
      const effectiveUsage = response.usage ?? observedUsage;
      if (effectiveUsage === undefined) {
        this.lastUsage = undefined;
        this.budget.recordMissingUsage();
      } else {
        this.lastUsage = effectiveUsage;
        this.budget.recordUsage(effectiveUsage, promptMessages, toolDefinitions);
      }

      if (signal.aborted) {
        return this.terminateWithSkippedTools(
          "aborted",
          "aborted",
          "The task was aborted after the model response.",
          assistantMessage.toolCalls
        );
      }
      if (this.activeTime.elapsedMs() >= this.limits.maxActiveMs) {
        return this.terminateWithSkippedTools(
          "limit_reached",
          "limit_reached",
          limitViolationMessage("active_time_limit"),
          assistantMessage.toolCalls
        );
      }

      this.setState("validating_tools");
      if (assistantMessage.toolCalls.length === 0) {
        const noFinishViolation = this.limits.recordTextOnlyTurn();
        if (noFinishViolation !== undefined) {
          return this.terminate("failed", "protocol_error", limitViolationMessage(noFinishViolation));
        }
        this.setState("recording_results");
        this.messages.push({ role: "user", content: PROTOCOL_REMINDER });
        continue;
      }

      this.limits.recordToolTurn();
      for (const toolCall of assistantMessage.toolCalls) {
        this.emit({ type: "tool_requested", toolCall: safeToolCall(toolCall, (value) => this.redact(value)) });
      }

      const validation = this.validateBatch(assistantMessage.toolCalls);
      if (validation.repetitionViolation !== undefined) {
        this.appendRejectedResults(
          assistantMessage.toolCalls,
          "batch_rejected",
          `The repeated tool call was not executed for the third consecutive time (signature count: ${validation.repetitionViolation.count}).`
        );
        return this.terminate("limit_reached", "limit_reached", "The task stopped because the same tool call was repeated three times.");
      }
      if (validation.issues.size > 0) {
        this.appendInvalidBatchResults(assistantMessage.toolCalls, validation.issues);
        continue;
      }

      this.repetition.commitBatch(assistantMessage.toolCalls);
      const outcome = await this.executeBatch(validation.validEntries, assistantMessage.toolCalls, signal);
      if (outcome !== undefined) {
        return outcome;
      }
    }
  }

  private validateBatch(calls: readonly ToolCall[]): BatchValidation {
    const issues = new Map<number, string>();
    const idCounts = new Map<string, number>();
    for (const call of calls) {
      if (call.id.trim().length > 0) {
        idCounts.set(call.id, (idCounts.get(call.id) ?? 0) + 1);
      }
    }

    const validEntries: ValidatedToolCall[] = [];
    const finishIndexes: number[] = [];
    for (const [index, call] of calls.entries()) {
      const callIssues: string[] = [];
      if (call.id.trim().length === 0) {
        callIssues.push("tool-call ID must be non-empty");
      } else if ((idCounts.get(call.id) ?? 0) > 1) {
        callIssues.push(`tool-call ID is duplicated: ${call.id}`);
      }

      const definition = this.tools.get(call.name);
      if (definition === undefined) {
        callIssues.push(`unknown tool: ${call.name}`);
      }
      if (call.name === "finish") {
        finishIndexes.push(index);
      }

      let validatedArgs: unknown;
      if (definition !== undefined) {
        const validation = definition.validate(call.arguments);
        if (!validation.ok) {
          callIssues.push(formatValidationIssues(validation.issues));
        } else {
          validatedArgs = validation.value;
        }
      }
      if (callIssues.length > 0) {
        issues.set(index, callIssues.join("; "));
      } else if (definition !== undefined) {
        validEntries.push({ index, call, definition, args: validatedArgs });
      }
    }

    if (finishIndexes.length > 0 && calls.length !== 1) {
      for (const finishIndex of finishIndexes) {
        const previous = issues.get(finishIndex);
        const finishIssue = "finish must be the only tool call in a response";
        issues.set(finishIndex, previous === undefined ? finishIssue : `${previous}; ${finishIssue}`);
      }
    }

    if (issues.size > 0) {
      return { validEntries: [], issues };
    }

    const repetitionViolation = this.repetition.previewBatch(calls);
    return repetitionViolation === undefined
      ? { validEntries, issues }
      : { validEntries: [], issues, repetitionViolation };
  }

  private async executeBatch(
    entries: readonly ValidatedToolCall[],
    calls: readonly ToolCall[],
    signal: AbortSignal
  ): Promise<AgentRunResult | undefined> {
    let finishResult: ToolResult | undefined;
    for (const [entryIndex, entry] of entries.entries()) {
      const remainingCalls = calls.slice(entryIndex + 1);
      if (signal.aborted) {
        this.appendRejectedResults(remainingCalls, "aborted", "Tool call was skipped because the task was aborted.");
        return this.terminate("aborted", "aborted", "The task was aborted during tool execution.");
      }
      if (this.activeTime.elapsedMs() >= this.limits.maxActiveMs) {
        this.appendRejectedResults(remainingCalls, "batch_rejected", "Tool call was skipped because the active time limit was reached.");
        return this.terminate("limit_reached", "limit_reached", limitViolationMessage("active_time_limit"));
      }

      this.setState("executing_tool");
      await this.beforeToolExecution?.(entry.call, this.executionCheckpoint());
      let result: ToolResult;
      try {
        result = await entry.definition.execute(this.executionContext, entry.args, signal);
        result = this.normalizeToolResult(result);
      } catch (error) {
        result = {
          status: signal.aborted ? "aborted" : "error",
          content: signal.aborted ? "Tool execution was aborted." : this.redact(safeErrorMessage(error))
        };
      }
      if (signal.aborted && result.status === "ok") {
        result = {
          status: "aborted",
          content: "Tool completed after task cancellation; side-effect state may have changed."
        };
      }
      this.emitToolCompleted(entry.call, result);
      this.setState("recording_results");
      this.appendToolResult(entry.call, result, false);
      await this.afterToolExecution?.(entry.call, result, this.executionCheckpoint());
      if (entry.call.name === "finish") {
        finishResult = result;
      }

      const errorViolation = this.limits.recordToolResult(result.status, {
        approvalDenied: entry.call.name === "run_command" && result.status === "permission_denied"
      });
      if (result.status === "aborted" || result.status === "interrupted") {
        this.appendRejectedResults(remainingCalls, "aborted", "Tool call was skipped because a preceding tool was aborted.");
        return this.terminate("aborted", "aborted", "The task was aborted during tool execution.");
      }
      if (errorViolation !== undefined) {
        this.appendRejectedResults(remainingCalls, "batch_rejected", "Tool call was skipped after the consecutive tool error limit was reached.");
        return this.terminate("limit_reached", "limit_reached", limitViolationMessage(errorViolation));
      }
    }

    const finishEntry = entries.find((entry) => entry.call.name === "finish");
    if (finishEntry !== undefined) {
      const finishArgs = normalizeFinishArgs(finishEntry.args as FinishArgs);
      this.finishArgs = finishArgs;
      if (finishResult?.status !== "ok") {
        return this.terminate("failed", "finish_failure", "The finish tool did not return an accepted result.");
      }
      const terminal = finishTerminalState(finishArgs.status);
      return this.terminate(
        terminal.state,
        terminal.reason,
        finishArgs.summary,
        finishArgs
      );
    }
    return undefined;
  }

  private appendInvalidBatchResults(calls: readonly ToolCall[], issues: ReadonlyMap<number, string>): void {
    this.setState("recording_results");
    for (const [index, call] of calls.entries()) {
      const issue = issues.get(index);
      const result: ToolResult = issue === undefined
        ? {
            status: "batch_rejected",
            content: "This tool call was not executed because another call in the batch was invalid."
          }
        : {
            status: "error",
            content: `Tool call rejected before execution: ${issue}`
          };
      this.appendToolResult(call, result);
    }
  }

  private appendRejectedResults(
    calls: readonly ToolCall[],
    status: Extract<ToolExecutionStatus, "batch_rejected" | "aborted">,
    content: string
  ): void {
    if (calls.length === 0) {
      return;
    }
    this.setState("recording_results");
    for (const call of calls) {
      this.appendToolResult(call, { status, content });
    }
  }

  private appendToolResult(call: ToolCall, result: ToolResult, emitEvent = true): void {
    const content = result.status === "ok" ? result.content : `[${result.status}] ${result.content}`;
    const message: ToolResultMessage = {
      role: "tool",
      toolCallId: call.id,
      toolName: call.name,
      content: this.redact(content)
    };
    this.messages.push(message);
    this.emitToolCompleted(call, result, emitEvent);
  }

  private normalizeToolResult(result: ToolResult): ToolResult {
    if (!isToolExecutionStatus(result.status) || typeof result.content !== "string") {
      return { status: "error", content: "Tool returned an invalid result." };
    }
    return {
      ...result,
      content: this.redact(result.content)
    };
  }

  private emitToolCompleted(call: ToolCall, result: ToolResult, emit = true): void {
    if (!emit) {
      return;
    }
    const summary = result.content.length > 500 ? `${result.content.slice(0, 500)}…` : result.content;
    this.emit({
      type: "tool_completed",
      toolCallId: call.id,
      status: result.status,
      summary: this.redact(summary)
    });
  }

  private emitBudgetWarning(decision: ContextBudgetDecision): void {
    if (decision.warning === undefined) {
      return;
    }
    this.emit({
      type: "context_warning",
      message: decision.warning,
      ratio: decision.ratio
    });
  }

  private beginApproval(request: ApprovalRequest): void {
    this.activeTime.pause();
    this.setState("awaiting_approval");
    this.emit({
      type: "approval_requested",
      command: this.redact(request.command),
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
      riskNote: request.riskNote
    });
  }

  private endApproval(approved: boolean): void {
    this.activeTime.resume();
    this.emit({ type: "approval_resolved", approved });
    this.setState("executing_tool");
  }

  private handleProviderError(error: unknown, signal: AbortSignal): AgentRunResult {
    const normalized = normalizeLlmProviderError(error, { externallyAborted: signal.aborted });
    if (signal.aborted || normalized.kind === "cancelled") {
      return this.terminate("aborted", "aborted", "The LLM request was cancelled.");
    }
    if (normalized.kind === "protocol") {
      return this.terminate("failed", "protocol_error", normalized.message);
    }
    return this.terminate("failed", "provider_error", normalized.message);
  }

  private terminateWithSkippedTools(
    state: TerminalState,
    reason: TerminationReason,
    message: string,
    calls: readonly ToolCall[]
  ): AgentRunResult {
    if (calls.length > 0) {
      this.appendRejectedResults(calls, state === "aborted" ? "aborted" : "batch_rejected", "Tool call was skipped because the task terminated before execution.");
    }
    return this.terminate(state, reason, message);
  }

  private terminate(
    state: TerminalState,
    reason: TerminationReason,
    message: string,
    finish?: ResolvedFinishArgs
  ): AgentRunResult {
    this.setState(state);
    const eventMessage = this.redact(message);
    this.emit({ type: "agent_terminated", state, reason, message: eventMessage });
    return {
      terminalState: state,
      state,
      reason,
      message: eventMessage,
      messages: [...this.messages],
      events: [...this.events],
      limits: this.limits.snapshot(this.activeTime.elapsedMs()),
      ...(this.lastUsage === undefined ? {} : { usage: this.lastUsage }),
      ...(finish === undefined ? {} : { finish })
    };
  }

  private executionCheckpoint(): ToolExecutionCheckpoint {
    return {
      messages: [...this.messages],
      limits: this.limits.snapshot(this.activeTime.elapsedMs()),
      ...(this.lastUsage === undefined ? {} : { usage: this.lastUsage })
    };
  }

  private setState(state: AgentState): void {
    this.state = state;
    this.emit({ type: "state_changed", state });
  }

  private emit(event: AgentEvent): void {
    this.events.push(event);
    try {
      this.onEvent?.(event);
    } catch {
      // UI observers must not be able to corrupt the agent state machine.
    }
  }

  private redact(value: string): string {
    return redactSecrets(value, this.baseToolContext.redactionSecrets ?? []);
  }
}

export {
  DEFAULT_MAX_ACTIVE_MS,
  DEFAULT_MAX_CONSECUTIVE_TOOL_ERRORS,
  DEFAULT_MAX_LLM_REQUESTS,
  DEFAULT_MAX_NO_FINISH_TURNS
};
