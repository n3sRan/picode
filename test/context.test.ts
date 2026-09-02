import { describe, expect, it } from "vitest";
import type { AssistantMessage, Message, ToolCall } from "../src/domain/messages.js";
import { LlmProviderError } from "../src/domain/errors.js";
import {
  CONTEXT_SUMMARY_MARKER,
  ContextCompactionError,
  ContextCompactor
} from "../src/context/index.js";
import { ScriptedLlmProvider, type LlmResponse } from "../src/llm/provider.js";

function call(id: string, name = "read_file"): ToolCall {
  return {
    id,
    name,
    rawArguments: JSON.stringify({ path: `${id}.txt` }),
    arguments: { path: `${id}.txt` }
  };
}

function assistant(content: string, toolCalls: ToolCall[] = []): AssistantMessage {
  return {
    role: "assistant",
    content,
    toolCalls,
    finishReason: toolCalls.length === 0 ? "stop" : "tool_calls"
  };
}

function textResponse(content: string): LlmResponse {
  return { message: assistant(content) };
}

describe("ContextCompactor", () => {
  it("summarizes complete historical groups while preserving the current task and latest turn", async () => {
    const oldRead = call("old-read");
    const oldWrite = call("old-write", "write_file");
    const messages: Message[] = [
      { role: "system", content: "You are picode." },
      { role: "user", content: "Original task" },
      assistant("", [oldRead]),
      { role: "tool", toolCallId: oldRead.id, toolName: oldRead.name, content: "old read result" },
      assistant("intermediate answer"),
      { role: "user", content: "Continue with the current task" },
      assistant("", [oldWrite]),
      { role: "tool", toolCallId: oldWrite.id, toolName: oldWrite.name, content: "old write result" },
      { role: "user", content: "Current task details" },
      assistant("Latest answer")
    ];
    const provider = new ScriptedLlmProvider([{ response: textResponse("Historical facts retained.") }]);

    const result = await new ContextCompactor({ provider }).compact(messages);

    expect(result.changed).toBe(true);
    expect(result.removedGroupCount).toBe(3);
    expect(result.removedMessageCount).toBe(5);
    expect(result.summary).toBe("Historical facts retained.");
    expect(result.messages).toContainEqual({ role: "system", content: "You are picode." });
    expect(result.messages).toContainEqual({ role: "user", content: "Current task details" });
    expect(result.messages).toContainEqual(assistant("Latest answer"));
    expect(result.messages.some((message) => message.role === "tool" && message.toolCallId === oldRead.id)).toBe(false);
    expect(result.messages.some((message) => message.role === "tool" && message.toolCallId === oldWrite.id)).toBe(false);
    expect(result.messages.some((message) => message.role === "assistant" && message.content.includes(CONTEXT_SUMMARY_MARKER))).toBe(true);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.tools).toBeUndefined();
  });

  it("returns a no-op when only an incomplete tool group is available", async () => {
    const pending = call("pending");
    const messages: Message[] = [
      { role: "system", content: "You are picode." },
      { role: "user", content: "Current task" },
      assistant("", [pending])
    ];
    const provider = new ScriptedLlmProvider([]);

    const result = await new ContextCompactor({ provider }).compact(messages);

    expect(result).toMatchObject({
      changed: false,
      removedMessageCount: 0,
      removedGroupCount: 0
    });
    expect(result.messages).toEqual(messages);
    expect(provider.requests).toHaveLength(0);
  });

  it("compacts the latest historical group when a new current task is trailing", async () => {
    const oldRead = call("old-read");
    const messages: Message[] = [
      { role: "system", content: "You are picode." },
      { role: "user", content: "Old task" },
      assistant("", [oldRead]),
      { role: "tool", toolCallId: oldRead.id, toolName: oldRead.name, content: "old result" },
      { role: "user", content: "Current task" }
    ];
    const provider = new ScriptedLlmProvider([{ response: textResponse("Historical summary") }]);

    const result = await new ContextCompactor({ provider }).compact(messages);

    expect(result.changed).toBe(true);
    expect(result.removedGroupCount).toBe(1);
    expect(result.messages).toContainEqual({ role: "user", content: "Current task" });
    expect(result.messages.some((message) => message.role === "tool" && message.toolCallId === oldRead.id)).toBe(false);
  });

  it("redacts the transcript and keeps the original history untouched when the summary fails", async () => {
    const oldRead = call("old-read");
    const messages: Message[] = [
      { role: "system", content: "You are picode." },
      { role: "user", content: "The secret is context-secret" },
      assistant("", [oldRead]),
      { role: "tool", toolCallId: oldRead.id, toolName: oldRead.name, content: "context-secret" },
      { role: "user", content: "Current task" },
      assistant("Latest answer")
    ];
    const provider = new ScriptedLlmProvider([{
      response: textResponse("Summary mentions context-secret")
    }]);
    const original = structuredClone(messages);

    const result = await new ContextCompactor({
      provider,
      redactionSecrets: ["context-secret"]
    }).compact(messages);

    expect(result.summary).toBe("Summary mentions [REDACTED]");
    expect(provider.requests[0]?.messages.some((message) => message.content.includes("context-secret"))).toBe(false);
    expect(messages).toEqual(original);
  });

  it("wraps provider failures without returning a partially compacted history", async () => {
    const oldRead = call("old-read");
    const messages: Message[] = [
      { role: "system", content: "You are picode." },
      { role: "user", content: "Old task" },
      assistant("", [oldRead]),
      { role: "tool", toolCallId: oldRead.id, toolName: oldRead.name, content: "old result" },
      { role: "user", content: "Current task" },
      assistant("Latest answer")
    ];
    const provider = new ScriptedLlmProvider([{
      error: new LlmProviderError("network", "network failure with secret", { retryable: false })
    }]);

    await expect(new ContextCompactor({
      provider,
      redactionSecrets: ["secret"]
    }).compact(messages)).rejects.toEqual(
      new ContextCompactionError("Context compaction request failed: network failure with [REDACTED]")
    );
    expect(messages).toHaveLength(6);
  });
});
