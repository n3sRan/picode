import type { AssistantMessage, LlmUsage, ToolCall } from "./messages.js";
import type { ContextCompactionMode, ContextUsage } from "./context.js";
import type { AgentState, TerminalState, TerminationReason } from "./state.js";
import type { ToolExecutionStatus } from "./tool.js";

export type { ToolExecutionStatus } from "./tool.js";

export type AgentEvent =
  | { type: "state_changed"; state: AgentState }
  | { type: "assistant_text_delta"; delta: string }
  | { type: "assistant_message_completed"; message: AssistantMessage }
  | { type: "llm_usage_received"; usage: LlmUsage }
  | { type: "tool_requested"; toolCall: ToolCall }
  | {
      type: "approval_requested";
      command: string;
      cwd: string;
      timeoutMs: number;
      riskNote: string;
    }
  | { type: "approval_resolved"; approved: boolean }
  | { type: "tool_completed"; toolCallId: string; status: ToolExecutionStatus; summary: string }
  | { type: "context_warning"; message: string; ratio: number }
  | { type: "context_usage"; usage: ContextUsage }
  | { type: "context_compaction_started"; mode: ContextCompactionMode }
  | {
      type: "context_compacted";
      mode: ContextCompactionMode;
      before: ContextUsage;
      after: ContextUsage;
      removedMessageCount: number;
      removedGroupCount: number;
    }
  | {
      type: "agent_terminated";
      state: TerminalState;
      reason: TerminationReason;
      message: string;
      contextUsage?: ContextUsage;
    };
