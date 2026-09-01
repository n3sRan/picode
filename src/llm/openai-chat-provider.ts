import OpenAI from "openai";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../config.js";
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming
} from "openai/resources/chat/completions/completions.js";
import { isJsonObject, type LlmFinishReason, type LlmUsage, type ToolCall } from "../domain/messages.js";
import {
  LlmProviderError,
  normalizeLlmProviderError,
  protocolError
} from "../domain/errors.js";
import { toChatCompletionMessages, toChatCompletionTools } from "./message-mapper.js";
import type { LlmProvider, LlmRequest, LlmResponse, LlmStreamHandlers } from "./provider.js";

export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 120_000;
export { DEFAULT_MAX_OUTPUT_TOKENS } from "../config.js";

export interface ChatCompletionsClient {
  chat: {
    completions: {
      create(
        body: ChatCompletionCreateParamsStreaming,
        options?: { signal?: AbortSignal }
      ): PromiseLike<AsyncIterable<ChatCompletionChunk>>;
    };
  };
}

export interface OpenAIChatProviderOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  requestTimeoutMs?: number;
  maxOutputTokens?: number;
  client?: ChatCompletionsClient;
}

interface ToolCallAccumulator {
  id?: string;
  name?: string;
  rawArguments: string;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("request aborted");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortReason(signal);
  }
}

async function raceWithAbort<T>(operation: () => PromiseLike<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);

  let removeAbortListener: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) {
      onAbort();
    }
  });

  try {
    return await Promise.race([operation(), abortPromise]);
  } finally {
    removeAbortListener?.();
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function readRecordProperty(record: unknown, key: string): unknown {
  if (!isJsonObject(record)) {
    return undefined;
  }
  return record[key];
}

function normalizeUsage(rawUsage: unknown): LlmUsage | undefined {
  if (rawUsage === undefined || rawUsage === null) {
    return undefined;
  }
  if (!isJsonObject(rawUsage)) {
    throw protocolError("usage must be an object");
  }

  const promptTokens = rawUsage.prompt_tokens;
  if (!isNonNegativeInteger(promptTokens)) {
    throw protocolError("usage.prompt_tokens must be a non-negative integer");
  }

  const completionTokens = rawUsage.completion_tokens;
  const totalTokens = rawUsage.total_tokens;
  if (completionTokens !== undefined && !isNonNegativeInteger(completionTokens)) {
    throw protocolError("usage.completion_tokens must be a non-negative integer");
  }
  if (totalTokens !== undefined && !isNonNegativeInteger(totalTokens)) {
    throw protocolError("usage.total_tokens must be a non-negative integer");
  }

  return {
    promptTokens,
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens })
  };
}

function normalizeFinishReason(value: unknown): LlmFinishReason {
  if (
    value === "stop" ||
    value === "length" ||
    value === "tool_calls" ||
    value === "content_filter" ||
    value === "function_call"
  ) {
    return value;
  }
  throw protocolError("finish_reason is missing or unsupported");
}

function addToolCallFragment(
  accumulators: Map<number, ToolCallAccumulator>,
  fragment: unknown
): void {
  if (!isJsonObject(fragment)) {
    throw protocolError("tool call fragment must be an object");
  }

  const index = fragment.index;
  if (!isNonNegativeInteger(index)) {
    throw protocolError("tool call fragment index must be a non-negative integer");
  }

  const accumulator = accumulators.get(index) ?? { rawArguments: "" };
  const id = fragment.id;
  if (id !== undefined) {
    if (typeof id !== "string" || id.trim().length === 0) {
      throw protocolError("tool call id must not be empty");
    }
    if (accumulator.id !== undefined && accumulator.id !== id) {
      throw protocolError("tool call id changed during streaming");
    }
    for (const [otherIndex, otherAccumulator] of accumulators) {
      if (otherIndex !== index && otherAccumulator.id === id) {
        throw protocolError("tool call ids must be unique");
      }
    }
    accumulator.id = id;
  }

  const functionValue = fragment.function;
  if (functionValue !== undefined && !isJsonObject(functionValue)) {
    throw protocolError("tool call function must be an object");
  }
  const functionName = readRecordProperty(functionValue, "name");
  if (functionName !== undefined) {
    if (typeof functionName !== "string" || functionName.trim().length === 0) {
      throw protocolError("tool call name must not be empty");
    }
    if (accumulator.name !== undefined && accumulator.name !== functionName) {
      throw protocolError("tool call name changed during streaming");
    }
    accumulator.name = functionName;
  }

  const argumentFragment = readRecordProperty(functionValue, "arguments");
  if (argumentFragment !== undefined) {
    if (typeof argumentFragment !== "string") {
      throw protocolError("tool call arguments fragment must be a string");
    }
    accumulator.rawArguments += argumentFragment;
  }
  accumulators.set(index, accumulator);
}

function finalizeToolCalls(accumulators: Map<number, ToolCallAccumulator>): ToolCall[] {
  const toolCalls: ToolCall[] = [];
  const ids = new Set<string>();
  for (const [, accumulator] of [...accumulators.entries()].sort(([left], [right]) => left - right)) {
    if (accumulator.id === undefined) {
      throw protocolError("tool call id is missing");
    }
    if (accumulator.name === undefined || accumulator.name.trim().length === 0) {
      throw protocolError("tool call name is missing");
    }
    if (ids.has(accumulator.id)) {
      throw protocolError("tool call ids must be unique");
    }
    ids.add(accumulator.id);

    let parsedArguments: unknown;
    try {
      parsedArguments = JSON.parse(accumulator.rawArguments) as unknown;
    } catch {
      throw protocolError("tool call arguments must be valid JSON");
    }
    if (!isJsonObject(parsedArguments)) {
      throw protocolError("tool call arguments must be a JSON object");
    }

    toolCalls.push({
      id: accumulator.id,
      name: accumulator.name,
      rawArguments: accumulator.rawArguments,
      arguments: parsedArguments
    });
  }
  return toolCalls;
}

function validateChunk(chunk: unknown): asserts chunk is ChatCompletionChunk {
  if (!isJsonObject(chunk) || !Array.isArray(chunk.choices)) {
    throw protocolError("stream chunk choices must be an array");
  }
}

export class OpenAIChatProvider implements LlmProvider {
  private readonly client: ChatCompletionsClient;
  private readonly model: string;
  private readonly requestTimeoutMs: number;
  private readonly maxOutputTokens: number;

  public constructor(options: OpenAIChatProviderOptions) {
    this.model = options.model;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS;
    this.maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    if (!Number.isInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new Error("requestTimeoutMs must be a positive integer");
    }
    if (!Number.isInteger(this.maxOutputTokens) || this.maxOutputTokens <= 0) {
      throw new Error("maxOutputTokens must be a positive integer");
    }

    this.client = options.client ?? (new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
      timeout: this.requestTimeoutMs,
      maxRetries: 0
    }) as unknown as ChatCompletionsClient);
  }

  public async complete(request: LlmRequest, handlers: LlmStreamHandlers = {}): Promise<LlmResponse> {
    const timeoutController = new AbortController();
    let timedOut = false;
    const externalSignal = request.signal;
    const requestSignal = externalSignal === undefined
      ? timeoutController.signal
      : AbortSignal.any([externalSignal, timeoutController.signal]);

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      timeoutController.abort(new Error("request timeout"));
    }, this.requestTimeoutMs);

    try {
      throwIfAborted(requestSignal);
      const requestBody = this.buildRequestBody(request);
      const stream = await raceWithAbort(
        () => this.client.chat.completions.create(requestBody, { signal: requestSignal }),
        requestSignal
      );
      return await raceWithAbort(
        () => this.consumeStream(stream, handlers, requestSignal),
        requestSignal
      );
    } catch (error) {
      throw normalizeLlmProviderError(error, {
        externallyAborted: externalSignal?.aborted === true,
        timedOut
      });
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private buildRequestBody(request: LlmRequest): ChatCompletionCreateParamsStreaming {
    const body: ChatCompletionCreateParamsStreaming = {
      model: this.model,
      messages: toChatCompletionMessages(request.messages),
      max_tokens: this.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true }
    };
    if (request.tools !== undefined && request.tools.length > 0) {
      body.tools = toChatCompletionTools(request.tools);
      body.tool_choice = "auto";
    }
    return body;
  }

  private async consumeStream(
    stream: AsyncIterable<ChatCompletionChunk>,
    handlers: LlmStreamHandlers,
    signal: AbortSignal
  ): Promise<LlmResponse> {
    let content = "";
    let finishReason: LlmFinishReason | undefined;
    let usage: LlmUsage | undefined;
    const toolCallAccumulators = new Map<number, ToolCallAccumulator>();

    for await (const chunk of stream) {
      throwIfAborted(signal);
      validateChunk(chunk);
      const chunkUsage = normalizeUsage(chunk.usage);
      if (chunkUsage !== undefined) {
        throwIfAborted(signal);
        usage = chunkUsage;
        await handlers.onUsage?.(chunkUsage);
        throwIfAborted(signal);
      }

      const choice = chunk.choices.find((candidate) => candidate.index === 0);
      if (choice === undefined) {
        continue;
      }

      if (choice.delta.function_call !== undefined && choice.delta.function_call !== null) {
        throw protocolError("legacy function_call streaming is not supported");
      }
      if (choice.delta.content !== undefined && choice.delta.content !== null) {
        if (typeof choice.delta.content !== "string") {
          throw protocolError("content delta must be a string");
        }
        throwIfAborted(signal);
        content += choice.delta.content;
        await handlers.onTextDelta?.(choice.delta.content);
        throwIfAborted(signal);
      }
      for (const fragment of choice.delta.tool_calls ?? []) {
        throwIfAborted(signal);
        addToolCallFragment(toolCallAccumulators, fragment);
      }

      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        const nextFinishReason = normalizeFinishReason(choice.finish_reason);
        if (finishReason !== undefined && finishReason !== nextFinishReason) {
          throw protocolError("finish_reason changed during streaming");
        }
        finishReason = nextFinishReason;
      }
    }

    throwIfAborted(signal);
    if (finishReason === undefined) {
      throw protocolError("finish_reason is missing");
    }
    if (finishReason === "function_call") {
      throw protocolError("legacy function_call finish reason is not supported");
    }

    const toolCalls = finalizeToolCalls(toolCallAccumulators);
    if (finishReason === "tool_calls" && toolCalls.length === 0) {
      throw protocolError("tool_calls finish reason requires tool calls");
    }
    if (finishReason !== "tool_calls" && toolCalls.length > 0) {
      throw protocolError("tool calls require tool_calls finish reason");
    }

    return {
      message: {
        role: "assistant",
        content,
        toolCalls,
        finishReason
      },
      ...(usage === undefined ? {} : { usage })
    };
  }
}
