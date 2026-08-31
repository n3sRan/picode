import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LlmFinishReason, LlmUsage, Message } from "../domain/messages.js";
import type { AgentState, TerminalState, TerminationReason } from "../domain/state.js";
import type { LimitSnapshot } from "../agent/limits.js";
import { atomicWrite, canonicalDirectory } from "../fs-utils.js";
import { redactValue } from "../security/redact.js";

export const SESSION_SCHEMA_VERSION = 1;
export const DEFAULT_SESSION_ROOT = join(homedir(), ".picode");

export interface PendingToolSnapshot {
  toolCallId: string;
  toolName: string;
  startedAt: string;
}

export interface SessionTaskSnapshot {
  state: AgentState;
  terminalState?: TerminalState;
  reason?: TerminationReason;
  message?: string;
  limits?: LimitSnapshot;
}

export interface SessionSnapshot {
  version: typeof SESSION_SCHEMA_VERSION;
  id: string;
  name: string;
  workspaceRoot: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  usage?: LlmUsage;
  task?: SessionTaskSnapshot;
  pendingTool?: PendingToolSnapshot;
}

export interface SessionStoreOptions {
  workspaceRoot: string;
  rootDir?: string;
  redactionSecrets?: readonly (string | undefined)[];
  now?: () => Date;
}

export class SessionStoreError extends Error {
  public readonly name: string = "SessionStoreError";
}

export class SessionNotFoundError extends SessionStoreError {
  public readonly name = "SessionNotFoundError";

  public constructor(identifier: string) {
    super("Session not found: " + identifier);
  }
}

export class SessionAmbiguousError extends SessionStoreError {
  public readonly name = "SessionAmbiguousError";

  public constructor(prefix: string, matches: readonly string[]) {
    super(
      "Session ID is ambiguous: " +
        prefix +
        " (" +
        matches.map((id) => id.slice(0, 8)).join(", ") +
        ")"
    );
  }
}

export function workspaceHash(workspaceRoot: string): string {
  return createHash("sha256").update(workspaceRoot).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isLlmFinishReason(value: unknown): value is LlmFinishReason {
  return (
    value === "stop" ||
    value === "length" ||
    value === "tool_calls" ||
    value === "content_filter" ||
    value === "function_call"
  );
}

function isToolCall(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.name) &&
    isString(value.rawArguments) &&
    isRecord(value.arguments)
  );
}

function isMessage(value: unknown): value is Message {
  if (!isRecord(value) || !isString(value.role)) {
    return false;
  }
  switch (value.role) {
    case "system":
    case "user":
      return isString(value.content);
    case "assistant":
      return (
        isString(value.content) &&
        Array.isArray(value.toolCalls) &&
        value.toolCalls.every(isToolCall) &&
        isLlmFinishReason(value.finishReason)
      );
    case "tool":
      return isString(value.toolCallId) && isString(value.toolName) && isString(value.content);
    default:
      return false;
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isUsage(value: unknown): value is LlmUsage {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.promptTokens) &&
    (value.completionTokens === undefined || isNonNegativeInteger(value.completionTokens)) &&
    (value.totalTokens === undefined || isNonNegativeInteger(value.totalTokens))
  );
}

function isLimitSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.llmRequestCount) &&
    isNonNegativeNumber(value.activeElapsedMs) &&
    isNonNegativeInteger(value.consecutiveToolErrors) &&
    isNonNegativeInteger(value.consecutiveNoFinishTurns)
  );
}

function isAgentState(value: unknown): value is AgentState {
  return [
    "idle",
    "preparing_context",
    "streaming",
    "validating_tools",
    "awaiting_approval",
    "executing_tool",
    "recording_results",
    "completed",
    "partial",
    "failed",
    "aborted",
    "limit_reached"
  ].includes(value as AgentState);
}

function isTerminalState(value: unknown): value is TerminalState {
  return ["completed", "partial", "failed", "aborted", "limit_reached"].includes(value as TerminalState);
}

function isTerminationReason(value: unknown): value is TerminationReason {
  return [
    "finish_success",
    "finish_partial",
    "finish_failure",
    "provider_error",
    "protocol_error",
    "limit_reached",
    "aborted"
  ].includes(value as TerminationReason);
}

function isTaskSnapshot(value: unknown): boolean {
  if (!isRecord(value) || !isAgentState(value.state)) {
    return false;
  }
  return (
    (value.terminalState === undefined || isTerminalState(value.terminalState)) &&
    (value.reason === undefined || isTerminationReason(value.reason)) &&
    (value.message === undefined || isString(value.message)) &&
    (value.limits === undefined || isLimitSnapshot(value.limits))
  );
}

function isPendingToolSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.toolCallId) &&
    isString(value.toolName) &&
    isString(value.startedAt)
  );
}

function atomicWriteJson(filePath: string, value: unknown): void {
  try {
    atomicWrite(
      filePath,
      (temporaryPath) => writeFileSync(temporaryPath, JSON.stringify(value, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600
      }),
      { ensureParent: true }
    );
  } catch (error) {
    throw new SessionStoreError(
      "Unable to atomically write session file: " +
        filePath +
        ": " +
        (error instanceof Error ? error.message : String(error))
    );
  }
}

function parseSnapshot(value: unknown, filePath: string): SessionSnapshot {
  if (!isRecord(value)) {
    throw new SessionStoreError("Invalid session snapshot: " + filePath);
  }
  if (value.version !== SESSION_SCHEMA_VERSION) {
    throw new SessionStoreError("Unsupported session snapshot version: " + filePath);
  }
  if (
    !isString(value.id) ||
    !isSessionId(value.id) ||
    !isString(value.name) ||
    !isString(value.workspaceRoot) ||
    !isString(value.createdAt) ||
    !isString(value.updatedAt) ||
    !Array.isArray(value.messages) ||
    !value.messages.every(isMessage) ||
    (value.usage !== undefined && !isUsage(value.usage)) ||
    (value.task !== undefined && !isTaskSnapshot(value.task)) ||
    (value.pendingTool !== undefined && !isPendingToolSnapshot(value.pendingTool))
  ) {
    throw new SessionStoreError("Invalid session snapshot fields: " + filePath);
  }

  return value as unknown as SessionSnapshot;
}

function readSnapshot(filePath: string): SessionSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new SessionStoreError(
      "Unable to read session snapshot " +
        filePath +
        ": " +
        (error instanceof Error ? error.message : String(error))
    );
  }
  return parseSnapshot(parsed, filePath);
}

export class SessionStore {
  public readonly workspaceRoot: string;
  public readonly rootDir: string;
  public readonly workspaceDirectory: string;
  public readonly sessionsDirectory: string;

  private readonly redactionSecrets: readonly (string | undefined)[];
  private readonly now: () => Date;

  public constructor(options: SessionStoreOptions) {
    try {
      this.workspaceRoot = canonicalDirectory(options.workspaceRoot);
    } catch {
      throw new SessionStoreError("Workspace is not a directory: " + options.workspaceRoot);
    }
    this.rootDir = options.rootDir ?? DEFAULT_SESSION_ROOT;
    this.workspaceDirectory = join(this.rootDir, "projects", workspaceHash(this.workspaceRoot));
    this.sessionsDirectory = join(this.workspaceDirectory, "sessions");
    this.redactionSecrets = options.redactionSecrets ?? [];
    this.now = options.now ?? (() => new Date());
  }

  public create(name = "New session"): SessionSnapshot {
    const trimmedName = name.trim();
    if (trimmedName.length === 0 || trimmedName.length > 200) {
      throw new SessionStoreError("Session name must contain 1 to 200 characters");
    }
    const timestamp = this.now().toISOString();
    const snapshot: SessionSnapshot = {
      version: SESSION_SCHEMA_VERSION,
      id: randomUUID(),
      name: trimmedName,
      workspaceRoot: this.workspaceRoot,
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: []
    };
    this.save(snapshot);
    return snapshot;
  }

  public save(snapshot: SessionSnapshot): void {
    if (snapshot.version !== SESSION_SCHEMA_VERSION || !isSessionId(snapshot.id)) {
      throw new SessionStoreError("Cannot save an invalid session snapshot");
    }
    if (snapshot.workspaceRoot !== this.workspaceRoot) {
      throw new SessionStoreError("Session workspace does not match the current workspace");
    }
    const safeSnapshot = redactValue(snapshot, this.redactionSecrets);
    atomicWriteJson(this.sessionPath(snapshot.id), safeSnapshot);
    atomicWriteJson(this.projectPath(), {
      version: SESSION_SCHEMA_VERSION,
      workspaceRoot: this.workspaceRoot,
      workspaceHash: workspaceHash(this.workspaceRoot),
      updatedAt: snapshot.updatedAt
    });
  }

  public load(identifier: string): SessionSnapshot {
    const id = this.resolveSessionId(identifier);
    const snapshot = readSnapshot(this.sessionPath(id));
    if (snapshot.workspaceRoot !== this.workspaceRoot) {
      throw new SessionStoreError("Session belongs to another workspace: " + id);
    }
    return snapshot;
  }

  public list(): readonly SessionSnapshot[] {
    if (!existsSync(this.sessionsDirectory)) {
      return [];
    }
    const snapshots: SessionSnapshot[] = [];
    for (const entry of readdirSync(this.sessionsDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const snapshot = readSnapshot(join(this.sessionsDirectory, entry.name));
      if (snapshot.workspaceRoot !== this.workspaceRoot) {
        throw new SessionStoreError("Session belongs to another workspace: " + entry.name);
      }
      snapshots.push(snapshot);
    }
    return snapshots.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  public resolveSessionId(identifier: string): string {
    const prefix = identifier.trim();
    if (prefix.length === 0) {
      throw new SessionNotFoundError(identifier);
    }
    const snapshots = this.list();
    const exact = snapshots.find((snapshot) => snapshot.id === prefix);
    if (exact !== undefined) {
      return exact.id;
    }
    const matches = snapshots.filter((snapshot) => snapshot.id.startsWith(prefix));
    if (matches.length === 0) {
      throw new SessionNotFoundError(identifier);
    }
    if (matches.length > 1) {
      throw new SessionAmbiguousError(prefix, matches.map((snapshot) => snapshot.id));
    }
    return matches[0]!.id;
  }

  public latest(): SessionSnapshot | undefined {
    return this.list()[0];
  }

  private sessionPath(id: string): string {
    return join(this.sessionsDirectory, id + ".json");
  }

  private projectPath(): string {
    return join(this.workspaceDirectory, "project.json");
  }
}
