import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool
} from "openai/resources/chat/completions/completions.js";
import type { Message, AssistantMessage, ToolCall } from "../domain/messages.js";
import { isJsonObject, type JsonObject, type LlmFinishReason } from "../domain/messages.js";
import type { LlmToolDefinition } from "./provider.js";

export class MessageMappingError extends Error {
  public readonly name = "MessageMappingError";

  public constructor(message: string) {
    super(message);
  }
}

function assistantMessageToChatMessage(message: AssistantMessage): ChatCompletionAssistantMessageParam {
  const assistantMessage: ChatCompletionAssistantMessageParam = {
    role: "assistant",
    content: message.content.length === 0 ? null : message.content
  };
  if (message.toolCalls.length > 0) {
    assistantMessage.tool_calls = message.toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.name,
        arguments: toolCall.rawArguments
      }
    }));
  }
  return assistantMessage;
}

export function toChatCompletionMessages(messages: readonly Message[]): ChatCompletionMessageParam[] {
  return messages.map((message) => {
    switch (message.role) {
      case "system":
        return { role: "system", content: message.content };
      case "user":
        return { role: "user", content: message.content };
      case "assistant":
        return assistantMessageToChatMessage(message);
      case "tool":
        return {
          role: "tool",
          tool_call_id: message.toolCallId,
          content: message.content
        };
    }
  });
}

export function toChatCompletionTools(tools: readonly LlmToolDefinition[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}

function decodeToolCall(toolCall: ChatCompletionMessageToolCall): ToolCall {
  if (toolCall.type !== "function") {
    throw new MessageMappingError("only function tool calls are supported");
  }
  if (typeof toolCall.id !== "string" || toolCall.id.trim().length === 0) {
    throw new MessageMappingError("tool call id must not be empty");
  }
  if (
    !toolCall.function ||
    typeof toolCall.function.name !== "string" ||
    toolCall.function.name.trim().length === 0
  ) {
    throw new MessageMappingError("tool call name must not be empty");
  }

  const rawArguments = toolCall.function.arguments;
  if (typeof rawArguments !== "string") {
    throw new MessageMappingError("tool call arguments must be a string");
  }
  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(rawArguments) as unknown;
  } catch {
    throw new MessageMappingError("tool call arguments must be valid JSON");
  }
  if (!isJsonObject(parsedArguments)) {
    throw new MessageMappingError("tool call arguments must be a JSON object");
  }

  return {
    id: toolCall.id,
    name: toolCall.function.name,
    rawArguments,
    arguments: parsedArguments
  };
}

export function fromChatCompletionMessage(
  message: ChatCompletionMessage,
  finishReason: LlmFinishReason
): AssistantMessage {
  const toolCalls = (message.tool_calls ?? []).map(decodeToolCall);
  const ids = new Set<string>();
  for (const toolCall of toolCalls) {
    if (ids.has(toolCall.id)) {
      throw new MessageMappingError("tool call ids must be unique");
    }
    ids.add(toolCall.id);
  }

  return {
    role: "assistant",
    content: message.content ?? "",
    toolCalls,
    finishReason
  };
}

export function parseJsonObject(rawArguments: string): JsonObject {
  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(rawArguments) as unknown;
  } catch {
    throw new MessageMappingError("tool call arguments must be valid JSON");
  }
  if (!isJsonObject(parsedArguments)) {
    throw new MessageMappingError("tool call arguments must be a JSON object");
  }
  return parsedArguments;
}
