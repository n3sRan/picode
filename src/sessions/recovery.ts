import type { AssistantMessage, ToolResultMessage } from "../domain/messages.js";
import type { SessionSnapshot } from "./store.js";

export const UNKNOWN_PENDING_TOOL_MESSAGE =
  "The previous tool execution was interrupted; its side-effect state is unknown. Do not assume it completed.";

export interface SessionRecoveryResult {
  snapshot: SessionSnapshot;
  warning?: string;
}

export function recoverPendingTool(snapshot: SessionSnapshot, now = new Date()): SessionRecoveryResult {
  const pending = snapshot.pendingTool;
  let latestToolBatchIndex = -1;
  let latestToolBatch: AssistantMessage | undefined;
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = snapshot.messages[index];
    if (message?.role === "assistant" && message.toolCalls.length > 0) {
      latestToolBatchIndex = index;
      latestToolBatch = message;
      break;
    }
  }
  const resultIds = new Set(
    snapshot.messages
      .slice(latestToolBatchIndex === -1 ? 0 : latestToolBatchIndex + 1)
      .filter((message): message is ToolResultMessage => message.role === "tool")
      .map((message) => message.toolCallId)
  );
  const outstandingCalls = latestToolBatch === undefined
    ? (pending === undefined || resultIds.has(pending.toolCallId)
        ? []
        : [{ id: pending.toolCallId, name: pending.toolName }])
    : latestToolBatch.toolCalls.filter((toolCall) => !resultIds.has(toolCall.id));
  if (outstandingCalls.length === 0) {
    if (pending === undefined) {
      return { snapshot };
    }
    const { pendingTool: _pendingTool, ...withoutPendingTool } = snapshot;
    return {
      snapshot: {
        ...withoutPendingTool,
        updatedAt: now.toISOString(),
        task: {
          state: "aborted",
          terminalState: "aborted",
          reason: "aborted",
          message: "A pending tool marker was found after its result had been saved; the task was not replayed.",
          ...(snapshot.task?.limits === undefined ? {} : { limits: snapshot.task.limits })
        }
      },
      warning:
        "A pending marker remained after its tool result was saved; it was cleared without replaying the tool."
    };
  }

  const messages = [...snapshot.messages];
  for (const call of outstandingCalls) {
    messages.push({
      role: "tool",
      toolCallId: call.id,
      toolName: call.name,
      content: pending === undefined
        ? "[aborted] This tool call was not started before the previous task was interrupted."
        : "[aborted] " + UNKNOWN_PENDING_TOOL_MESSAGE
    });
  }
  const task = {
    state: "aborted" as const,
    terminalState: "aborted" as const,
    reason: "aborted" as const,
    message: UNKNOWN_PENDING_TOOL_MESSAGE,
    ...(snapshot.task?.limits === undefined ? {} : { limits: snapshot.task.limits })
  };
  const { pendingTool: _pendingTool, ...withoutPendingTool } = snapshot;
  return {
    snapshot: {
      ...withoutPendingTool,
      updatedAt: now.toISOString(),
      messages,
      task
    },
    warning: pending === undefined
      ? "An unfinished tool batch was found; missing tool results were restored as skipped and no tool was replayed."
      : "Previous tool " +
        pending.toolName +
        " (" +
        pending.toolCallId +
        ") was interrupted; side-effect state is unknown and it was not replayed."
  };
}
