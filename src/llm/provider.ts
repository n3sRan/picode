import type { JsonObject, LlmUsage, Message, AssistantMessage } from "../domain/messages.js";
import { LlmProviderError } from "../domain/errors.js";

export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: JsonObject;
}

export interface LlmRequest {
  messages: readonly Message[];
  tools?: readonly LlmToolDefinition[];
  signal?: AbortSignal;
}

export interface LlmResponse {
  message: AssistantMessage;
  usage?: LlmUsage;
}

export interface LlmStreamHandlers {
  onTextDelta?: (delta: string) => void | Promise<void>;
  onUsage?: (usage: LlmUsage) => void | Promise<void>;
}

export interface LlmProvider {
  complete(request: LlmRequest, handlers?: LlmStreamHandlers): Promise<LlmResponse>;
}

export interface ScriptedLlmTurn {
  response?: LlmResponse;
  textDeltas?: readonly string[];
  delayMs?: number;
  error?: LlmProviderError;
}

function abortError(): LlmProviderError {
  return new LlmProviderError("cancelled", "LLM request cancelled", { retryable: false });
}

function waitForDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortError());
  }

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onTimer = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortError());
    };
    timer = setTimeout(onTimer, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class ScriptedLlmProvider implements LlmProvider {
  public readonly requests: LlmRequest[] = [];
  private readonly turns: ScriptedLlmTurn[];

  public constructor(turns: readonly ScriptedLlmTurn[]) {
    this.turns = [...turns];
  }

  public async complete(request: LlmRequest, handlers: LlmStreamHandlers = {}): Promise<LlmResponse> {
    this.requests.push(request);
    if (request.signal?.aborted) {
      throw abortError();
    }

    const turn = this.turns.shift();
    if (turn === undefined) {
      throw new LlmProviderError("unknown", "Scripted provider has no remaining response", {
        retryable: false
      });
    }

    if (turn.delayMs !== undefined) {
      await waitForDelay(turn.delayMs, request.signal);
    }
    if (turn.error !== undefined) {
      throw turn.error;
    }
    if (turn.response === undefined) {
      throw new LlmProviderError("protocol", "Scripted provider turn has no response", {
        retryable: false
      });
    }

    const textDeltas = turn.textDeltas ?? (turn.response.message.content.length > 0
      ? [turn.response.message.content]
      : []);
    for (const delta of textDeltas) {
      await handlers.onTextDelta?.(delta);
    }
    if (turn.response.usage !== undefined) {
      await handlers.onUsage?.(turn.response.usage);
    }
    return turn.response;
  }
}
