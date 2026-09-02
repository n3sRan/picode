export type RuntimeState =
  | "idle"
  | "preparing_context"
  | "compacting_context"
  | "streaming"
  | "validating_tools"
  | "awaiting_approval"
  | "executing_tool"
  | "recording_results";

export type TerminalState = "completed" | "partial" | "failed" | "aborted" | "limit_reached";

export type AgentState = RuntimeState | TerminalState;

export type TerminationReason =
  | "finish_success"
  | "finish_partial"
  | "finish_failure"
  | "provider_error"
  | "protocol_error"
  | "limit_reached"
  | "aborted";
