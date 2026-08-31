export { ToolRegistry, ToolNotFoundError, ToolRegistryError } from "./registry.js";
export { createValidator, assertValid, formatValidationIssues, ToolArgumentValidationError, validateJsonSchema } from "./validators.js";
export type { JsonSchema } from "./validators.js";
export type {
  ShellRunRequest,
  ShellRunResult,
  ShellRunner,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionStatus,
  ToolResult,
  ValidationIssue,
  ValidationResult
} from "./types.js";
export { listFilesTool } from "./list-files.js";
export { searchFilesTool } from "./search-files.js";
export { readFileTool } from "./read-file.js";
export { writeFileTool } from "./write-file.js";
export { editFileTool } from "./edit-file.js";
export { runCommandTool, NodeShellRunner, DEFAULT_COMMAND_TIMEOUT_MS, riskNoteForCommand, buildCommandEnvironment } from "./run-command.js";
export { finishTool } from "./finish.js";
export { PathPolicy, PathPolicyError } from "../security/path-policy.js";
export { CliApprovalBroker, ScriptedApprovalBroker, formatApprovalPrompt } from "../security/approval.js";

import { ToolRegistry } from "./registry.js";
import { editFileTool } from "./edit-file.js";
import { finishTool } from "./finish.js";
import { listFilesTool } from "./list-files.js";
import { readFileTool } from "./read-file.js";
import { runCommandTool } from "./run-command.js";
import { searchFilesTool } from "./search-files.js";
import { writeFileTool } from "./write-file.js";

export function createBuiltinToolRegistry(): ToolRegistry {
  return new ToolRegistry([
    listFilesTool,
    searchFilesTool,
    readFileTool,
    writeFileTool,
    editFileTool,
    runCommandTool,
    finishTool
  ]);
}
