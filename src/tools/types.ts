import type { JsonObject } from "../domain/messages.js";
import type { ToolExecutionStatus } from "../domain/tool.js";
import type { ApprovalBroker } from "../security/approval.js";
import type { PathPolicy } from "../security/path-policy.js";

export type { ToolExecutionStatus } from "../domain/tool.js";

export interface ToolResult {
  status: ToolExecutionStatus;
  content: string;
  metadata?: JsonObject;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: readonly ValidationIssue[] };

export type ToolValidator<TArgs = JsonObject> = (
  value: unknown
) => ValidationResult<TArgs>;

export interface ShellRunRequest {
  command: string;
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  outputLimit: number;
  spillDirectory: string;
  redactionSecrets?: readonly (string | undefined)[] | undefined;
}

export type ShellRunStatus = "completed" | "timeout" | "aborted" | "spawn_error";

export interface ShellRunResult {
  status: ShellRunStatus;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutArtifactPath?: string;
  stderrArtifactPath?: string;
  errorMessage?: string;
}

export interface ShellRunner {
  run(request: ShellRunRequest, signal?: AbortSignal): Promise<ShellRunResult>;
}

export interface ToolExecutionContext {
  workspaceRoot: string;
  sessionId: string;
  sessionTmpDir: string;
  pathPolicy: PathPolicy;
  approvalBroker: ApprovalBroker;
  shellRunner?: ShellRunner;
  commandEnvironment?: NodeJS.ProcessEnv;
  /** Host-side search caps; omitted in normal CLI composition. */
  searchBudget?: {
    maxFiles?: number;
    maxBytes?: number;
  };
  redactionSecrets?: readonly (string | undefined)[];
}

export interface ToolDefinition<TArgs = JsonObject> {
  name: string;
  description: string;
  parameters: JsonObject;
  validate: ToolValidator<TArgs>;
  execute(context: ToolExecutionContext, args: TArgs, signal: AbortSignal): Promise<ToolResult>;
}
