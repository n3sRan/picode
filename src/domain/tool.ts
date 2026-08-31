export type ToolExecutionStatus =
  | "ok"
  | "error"
  | "permission_denied"
  | "aborted"
  | "timeout"
  | "interrupted"
  | "batch_rejected";
