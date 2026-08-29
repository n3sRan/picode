import type {
  ChatCompletionChunk,
  ChatCompletionMessage
} from "openai/resources/chat/completions/completions.js";
import { describe, expect, it, vi } from "vitest";
import { LlmProviderError, LlmProtocolError } from "../src/domain/errors.js";
import type { AssistantMessage, Message, ToolResultMessage } from "../src/domain/messages.js";
import { fromChatCompletionMessage, toChatCompletionMessages, toChatCompletionTools } from "../src/llm/message-mapper.js";
import {
  OpenAIChatProvider,
  type ChatCompletionsClient
} from "../src/llm/openai-chat-provider.js";
import { ScriptedLlmProvider } from "../src/llm/provider.js";

function makeChunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  usage?: Record<string, unknown>
): ChatCompletionChunk {
  return {
    id: "chatcmpl-phase1",
    created: 1,
    model: "test-model",
    object: "chat.completion.chunk",
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
        logprobs: null
      }
    ],
    ...(usage === undefined ? {} : { usage })
  } as unknown as ChatCompletionChunk;
}

function makeUsageChunk(usage?: Record<string, unknown>): ChatCompletionChunk {
  return {
    id: "chatcmpl-phase1",
    created: 1,
    model: "test-model",
    object: "chat.completion.chunk",
    choices: [],
    ...(usage === undefined ? {} : { usage })
  } as unknown as ChatCompletionChunk;
}

async function* streamChunks(chunks: readonly ChatCompletionChunk[]): AsyncGenerator<ChatCompletionChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function fakeClient(chunks: readonly ChatCompletionChunk[]): {
  client: ChatCompletionsClient;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(async () => streamChunks(chunks));
  return {
    client: {
      chat: {
        completions: { create }
      }
    },
    create
  };
}

function makeProvider(
  chunks: readonly ChatCompletionChunk[],
  options: { requestTimeoutMs?: number } = {}
): {
  provider: OpenAIChatProvider;
  create: ReturnType<typeof vi.fn>;
} {
  const fake = fakeClient(chunks);
  return {
    provider: new OpenAIChatProvider({
      apiKey: "phase1-test-credential",
      baseUrl: "https://gateway.example/v1",
      model: "test-model",
      client: fake.client,
      ...options
    }),
    create: fake.create
  };
}

function basicRequest() {
  return {
    messages: [{ role: "user", content: "hello" }] as const
  };
}

describe("OpenAIChatProvider", () => {
  it("streams text deltas, aggregates the assistant message, and records usage", async () => {
    const { provider, create } = makeProvider([
      makeChunk({ role: "assistant", content: "Hel" }),
      makeChunk({ content: "lo" }, "stop"),
      makeUsageChunk({ prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 })
    ]);
    const deltas: string[] = [];
    const usages: number[] = [];

    const response = await provider.complete(basicRequest(), {
      onTextDelta: (delta) => deltas.push(delta),
      onUsage: (usage) => usages.push(usage.promptTokens)
    });

    expect(response).toEqual({
      message: {
        role: "assistant",
        content: "Hello",
        toolCalls: [],
        finishReason: "stop"
      },
      usage: {
        promptTokens: 12,
        completionTokens: 4,
        totalTokens: 16
      }
    });
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(usages).toEqual([12]);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      model: "test-model",
      max_tokens: 16_384,
      stream: true,
      stream_options: { include_usage: true }
    });
  });

  it("allows a missing usage chunk and sends tool definitions", async () => {
    const { provider, create } = makeProvider([
      makeChunk({ role: "assistant", content: "done" }, "stop")
    ]);

    const response = await provider.complete({
      messages: basicRequest().messages,
      tools: [
        {
          name: "read_file",
          description: "Read a text file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false
          }
        }
      ]
    });

    expect(response.usage).toBeUndefined();
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      tools: [
        {
          type: "function",
          function: { name: "read_file" }
        }
      ],
      tool_choice: "auto"
    });
  });

  it("aggregates multiple tool calls and parses complete JSON arguments", async () => {
    const { provider } = makeProvider([
      makeChunk({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_read",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"' }
          },
          {
            index: 1,
            id: "call_write",
            type: "function",
            function: { name: "write_file", arguments: '{"path":"' }
          }
        ]
      }),
      makeChunk({
        tool_calls: [
          {
            index: 0,
            function: { arguments: "src/a.ts\"}" }
          },
          {
            index: 1,
            function: { arguments: 'src/b.ts","content":"ok"}' }
          }
        ]
      }, "tool_calls")
    ]);

    const response = await provider.complete(basicRequest());

    expect(response.message.toolCalls).toEqual([
      {
        id: "call_read",
        name: "read_file",
        rawArguments: '{"path":"src/a.ts"}',
        arguments: { path: "src/a.ts" }
      },
      {
        id: "call_write",
        name: "write_file",
        rawArguments: '{"path":"src/b.ts","content":"ok"}',
        arguments: { path: "src/b.ts", content: "ok" }
      }
    ]);
    expect(response.message.finishReason).toBe("tool_calls");
  });

  it.each([
    {
      name: "duplicate tool-call IDs",
      chunks: [
        makeChunk({
          tool_calls: [
            { index: 0, id: "duplicate", type: "function", function: { name: "one", arguments: "{}" } },
            { index: 1, id: "duplicate", type: "function", function: { name: "two", arguments: "{}" } }
          ]
        }, "tool_calls")
      ]
    },
    {
      name: "empty tool-call IDs",
      chunks: [
        makeChunk({
          tool_calls: [{ index: 0, id: "", type: "function", function: { name: "one", arguments: "{}" } }]
        }, "tool_calls")
      ]
    },
    {
      name: "invalid tool-call arguments",
      chunks: [
        makeChunk({
          tool_calls: [{ index: 0, id: "call_bad", type: "function", function: { name: "one", arguments: "not-json" } }]
        }, "tool_calls")
      ]
    },
    {
      name: "contradictory finish reason",
      chunks: [
        makeChunk({
          tool_calls: [{ index: 0, id: "call_stop", type: "function", function: { name: "one", arguments: "{}" } }]
        }, "stop")
      ]
    }
  ])("rejects $name as a protocol error", async ({ chunks }) => {
    const { provider } = makeProvider(chunks);

    await expect(provider.complete(basicRequest())).rejects.toMatchObject({
      name: "LlmProtocolError",
      kind: "protocol"
    });
  });

  it("normalizes authentication and network errors without exposing remote text", async () => {
    const authenticationClient: ChatCompletionsClient = {
      chat: {
        completions: {
          create: vi.fn(() => Promise.reject(Object.assign(new Error("credential-value"), { status: 401 })))
        }
      }
    };
    const networkClient: ChatCompletionsClient = {
      chat: {
        completions: {
          create: vi.fn(() => Promise.reject(Object.assign(new Error("socket detail"), { code: "ECONNRESET" })))
        }
      }
    };

    const authenticationProvider = new OpenAIChatProvider({
      apiKey: "credential-value",
      baseUrl: "https://gateway.example/v1",
      model: "test-model",
      client: authenticationClient
    });
    const networkProvider = new OpenAIChatProvider({
      apiKey: "phase1-test-credential",
      baseUrl: "https://gateway.example/v1",
      model: "test-model",
      client: networkClient
    });

    await expect(authenticationProvider.complete(basicRequest())).rejects.toMatchObject({
      kind: "authentication",
      status: 401,
      message: "LLM authentication failed"
    });
    await expect(networkProvider.complete(basicRequest())).rejects.toMatchObject({
      kind: "network",
      message: "LLM network request failed"
    });
    await expect(authenticationProvider.complete(basicRequest())).rejects.not.toThrow("credential-value");
  });

  it("normalizes provider timeout and caller cancellation", async () => {
    const neverResolvingClient: ChatCompletionsClient = {
      chat: {
        completions: {
          create: vi.fn(() => new Promise<AsyncIterable<ChatCompletionChunk>>(() => undefined))
        }
      }
    };
    const timeoutProvider = new OpenAIChatProvider({
      apiKey: "phase1-test-credential",
      baseUrl: "https://gateway.example/v1",
      model: "test-model",
      client: neverResolvingClient,
      requestTimeoutMs: 10
    });

    await expect(timeoutProvider.complete(basicRequest())).rejects.toMatchObject({
      kind: "timeout",
      message: "LLM request timed out"
    });

    const controller = new AbortController();
    controller.abort();
    await expect(timeoutProvider.complete({ ...basicRequest(), signal: controller.signal })).rejects.toMatchObject({
      kind: "cancelled",
      message: "LLM request cancelled"
    });
  });
});

describe("LlmProvider and message mapper", () => {
  it("scripted provider emits deterministic text and usage while recording requests", async () => {
    const response = {
      message: {
        role: "assistant",
        content: "hello",
        toolCalls: [],
        finishReason: "stop"
      },
      usage: { promptTokens: 3 }
    } satisfies {
      message: AssistantMessage;
      usage: { promptTokens: number };
    };
    const provider = new ScriptedLlmProvider([{ response, textDeltas: ["he", "llo"] }]);
    const deltas: string[] = [];
    const usages: number[] = [];

    const result = await provider.complete(basicRequest(), {
      onTextDelta: (delta) => deltas.push(delta),
      onUsage: (usage) => usages.push(usage.promptTokens)
    });

    expect(result).toEqual(response);
    expect(deltas).toEqual(["he", "llo"]);
    expect(usages).toEqual([3]);
    expect(provider.requests).toHaveLength(1);
  });

  it("round-trips assistant tool calls and maps tool results to Chat Completions messages", () => {
    const assistant: AssistantMessage = {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call_read",
          name: "read_file",
          rawArguments: '{"path":"README.md"}',
          arguments: { path: "README.md" }
        }
      ],
      finishReason: "tool_calls"
    };
    const toolResult: ToolResultMessage = {
      role: "tool",
      toolCallId: "call_read",
      toolName: "read_file",
      content: "file contents"
    };
    const messages: Message[] = [
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "Read README.md" },
      assistant,
      toolResult
    ];

    const mapped = toChatCompletionMessages(messages);
    const restored = fromChatCompletionMessage(
      mapped[2] as unknown as ChatCompletionMessage,
      "tool_calls"
    );

    expect(restored).toEqual(assistant);
    expect(mapped[3]).toEqual({
      role: "tool",
      tool_call_id: "call_read",
      content: "file contents"
    });
    expect(toChatCompletionTools([
      {
        name: "read_file",
        description: "Read a text file",
        parameters: { type: "object" }
      }
    ])).toEqual([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a text file",
          parameters: { type: "object" }
        }
      }
    ]);
  });

  it("rejects malformed assistant tool-call messages during reverse mapping", () => {
    const malformed = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_bad",
          type: "function",
          function: { name: "read_file", arguments: "[]" }
        }
      ]
    } as unknown as ChatCompletionMessage;

    expect(() => fromChatCompletionMessage(malformed, "tool_calls")).toThrow(
      "tool call arguments must be a JSON object"
    );
  });
});
