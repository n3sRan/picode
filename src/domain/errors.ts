export type LlmProviderErrorKind =
  | "authentication"
  | "rate_limit"
  | "network"
  | "timeout"
  | "cancelled"
  | "protocol"
  | "unknown";

export interface LlmProviderErrorOptions {
  status?: number;
  retryable?: boolean;
}

export class LlmProviderError extends Error {
  public readonly name: string = "LlmProviderError";
  public readonly kind: LlmProviderErrorKind;
  public readonly retryable: boolean;
  public readonly status?: number;

  public constructor(
    kind: LlmProviderErrorKind,
    message: string,
    options: LlmProviderErrorOptions = {}
  ) {
    super(message);
    this.kind = kind;
    this.retryable = options.retryable ?? ["rate_limit", "network", "timeout"].includes(kind);
    if (options.status !== undefined) {
      this.status = options.status;
    }
  }
}

export class LlmProtocolError extends LlmProviderError {
  public readonly name = "LlmProtocolError";

  public constructor(message: string) {
    super("protocol", `LLM protocol error: ${message}`, { retryable: false });
  }
}

export function protocolError(message: string): LlmProtocolError {
  return new LlmProtocolError(message);
}

export interface LlmErrorNormalizationContext {
  externallyAborted?: boolean;
  timedOut?: boolean;
}

function readProperty(error: unknown, key: string): unknown {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  return (error as Record<string, unknown>)[key];
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : String(readProperty(error, "name") ?? "");
}

function errorCode(error: unknown): string {
  return String(readProperty(error, "code") ?? "");
}

function errorStatus(error: unknown): number | undefined {
  const status = readProperty(error, "status");
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

function isNetworkError(error: unknown): boolean {
  const name = errorName(error);
  const code = errorCode(error);
  return (
    name === "APIConnectionError" ||
    ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNABORTED"].includes(code)
  );
}

function isTimeoutError(error: unknown): boolean {
  const name = errorName(error);
  const code = errorCode(error);
  return name === "APIConnectionTimeoutError" || name === "TimeoutError" || code === "ETIMEDOUT";
}

function isCancellationError(error: unknown): boolean {
  return errorName(error) === "AbortError" || errorCode(error) === "ABORT_ERR";
}

export function normalizeLlmProviderError(
  error: unknown,
  context: LlmErrorNormalizationContext = {}
): LlmProviderError {
  if (error instanceof LlmProviderError) {
    return error;
  }

  if (context.timedOut || isTimeoutError(error)) {
    return new LlmProviderError("timeout", "LLM request timed out");
  }

  if (context.externallyAborted || isCancellationError(error)) {
    return new LlmProviderError("cancelled", "LLM request cancelled", { retryable: false });
  }

  const status = errorStatus(error);
  if (status === 401 || status === 403) {
    return new LlmProviderError("authentication", "LLM authentication failed", {
      status,
      retryable: false
    });
  }

  if (status === 429) {
    return new LlmProviderError("rate_limit", "LLM request was rate limited", { status });
  }

  if (isNetworkError(error)) {
    return new LlmProviderError("network", "LLM network request failed");
  }

  return new LlmProviderError("unknown", "LLM request failed", {
    ...(status === undefined ? {} : { status }),
    retryable: status !== undefined && status >= 500
  });
}
