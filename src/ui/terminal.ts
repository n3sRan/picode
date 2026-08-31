import { createInterface, type Interface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { AgentRunResult, ToolExecutionCheckpoint } from "../agent/index.js";
import { AgentLoop } from "../agent/index.js";
import type { PicodeConfig } from "../config.js";
import { PathPolicy } from "../security/path-policy.js";
import { CliApprovalBroker } from "../security/approval.js";
import { createBuiltinToolRegistry } from "../tools/index.js";
import type { ToolCall } from "../domain/messages.js";
import type { ToolResult } from "../tools/types.js";
import {
  recoverPendingTool,
  SessionStore,
  type SessionSnapshot,
  type SessionTaskSnapshot
} from "../sessions/index.js";
import { CliCommandError, parseCliCommand, type CliCommand } from "./commands.js";
import type { LlmProvider } from "../llm/provider.js";
import { TerminalRenderer } from "./renderer.js";

export interface TerminalAppOptions {
  workspaceRoot: string;
  config: PicodeConfig;
  provider: LlmProvider;
  sessionStore: SessionStore;
  input?: Readable;
  output?: Writable;
  errorOutput?: Writable;
  isInteractive?: boolean;
}

export class TerminalBusyError extends Error {
  public readonly name = "TerminalBusyError";
}

export function exitCodeForTerminalState(state: AgentRunResult["terminalState"]): number {
  switch (state) {
    case "completed":
      return 0;
    case "partial":
      return 2;
    case "failed":
      return 3;
    case "limit_reached":
      return 4;
    case "aborted":
      return 130;
  }
}

export class TerminalApp {
  private readonly workspaceRoot: string;
  private readonly config: PicodeConfig;
  private readonly provider: LlmProvider;
  private readonly sessionStore: SessionStore;
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly errorOutput: Writable;
  private readonly isInteractive: boolean;
  private readonly renderer: TerminalRenderer;
  private currentSession: SessionSnapshot | undefined;
  private busy = false;
  private exiting = false;
  private activeAbort: AbortController | undefined;
  private lineInterface: Interface | undefined;
  private lineIterator: AsyncIterator<string> | undefined;

  public constructor(options: TerminalAppOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.config = options.config;
    this.provider = options.provider;
    this.sessionStore = options.sessionStore;
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.errorOutput = options.errorOutput ?? process.stderr;
    this.isInteractive = options.isInteractive ??
      ((this.input as Readable & { isTTY?: boolean }).isTTY === true &&
        (this.output as Writable & { isTTY?: boolean }).isTTY === true);
    this.renderer = new TerminalRenderer({
      output: this.output,
      errorOutput: this.errorOutput
    });
  }

  public getSession(): SessionSnapshot | undefined {
    return this.currentSession;
  }

  public isBusy(): boolean {
    return this.busy;
  }

  public async initialize(options: { newSession?: boolean } = {}): Promise<SessionSnapshot> {
    if (options.newSession === true || this.currentSession === undefined) {
      this.currentSession = options.newSession === true
        ? this.sessionStore.create("Task session")
        : this.sessionStore.latest() ?? this.sessionStore.create("New session");
      this.recoverCurrentSession();
    }
    return this.currentSession;
  }

  public async runTask(task: string, signal?: AbortSignal): Promise<AgentRunResult> {
    if (this.busy) {
      throw new TerminalBusyError("The agent is busy running another task");
    }
    const session = await this.initialize();
    this.busy = true;
    this.renderer.beginTask();
    const controller = new AbortController();
    this.activeAbort = controller;
    const onExternalAbort = () => controller.abort(signal?.reason);
    const onProcessInterrupt = () => controller.abort();
    if (signal?.aborted) {
      controller.abort(signal.reason);
    } else {
      signal?.addEventListener("abort", onExternalAbort, { once: true });
    }
    if (this.isInteractive) {
      process.once("SIGINT", onProcessInterrupt);
    }

    try {
      const initialMessages = [...session.messages];
      this.saveSession({
        messages: [...initialMessages, { role: "user", content: task }],
        task: { state: "idle" }
      });
      const pathPolicy = new PathPolicy({
        workspaceRoot: this.workspaceRoot,
        sessionId: session.id
      });
      const toolContext = {
        workspaceRoot: this.workspaceRoot,
        sessionId: session.id,
        sessionTmpDir: pathPolicy.sessionTmpDir,
        pathPolicy,
        approvalBroker: new CliApprovalBroker({
          input: this.input,
          output: this.errorOutput,
          isInteractive: this.isInteractive,
          question: (prompt, signal) => this.askSharedQuestion(prompt, signal)
        }),
        redactionSecrets: [this.config.apiKey]
      };
      const loop = new AgentLoop({
        provider: this.provider,
        tools: createBuiltinToolRegistry(),
        toolContext,
        initialMessages,
        contextWindow: this.config.contextWindow,
        onEvent: (event) => this.renderer.render(event),
        beforeToolExecution: (call, checkpoint) => this.savePendingTool(call, checkpoint),
        afterToolExecution: (call, result, checkpoint) =>
          this.saveToolResult(call, result, checkpoint)
      });
      const result = await loop.run(task, controller.signal);
      this.saveFinalResult(result);
      return result;
    } finally {
      if (signal !== undefined && !signal.aborted) {
        signal.removeEventListener("abort", onExternalAbort);
      }
      if (this.isInteractive) {
        process.removeListener("SIGINT", onProcessInterrupt);
      }
      this.activeAbort = undefined;
      this.busy = false;
    }
  }

  public async runInteractive(): Promise<number> {
    await this.initialize();
    this.renderer.renderSessionHeader(this.shortSessionId(), this.currentSession!.name);
    try {
      while (!this.exiting) {
        const line = await this.readLine();
        if (line === undefined) {
          break;
        }
        await this.handleLine(line);
      }
    } finally {
      this.closeLineReader();
    }
    return 0;
  }

  public async handleLine(line: string): Promise<void> {
    let command: CliCommand;
    try {
      command = parseCliCommand(line);
    } catch (error) {
      this.writeError(error instanceof CliCommandError ? error.message : String(error));
      return;
    }
    if (command.kind === "empty") {
      return;
    }
    if (this.busy) {
      this.writeError("Agent is busy; wait for the current task to terminate before switching sessions.");
      return;
    }

    try {
      switch (command.kind) {
        case "task":
          await this.runTask(command.text);
          return;
        case "new_session":
          this.currentSession = this.sessionStore.create(command.name);
          this.renderer.renderInfo("Created session " + this.shortSessionId() + ".");
          return;
        case "list_sessions":
          this.writeSessionList();
          return;
        case "resume_session":
          this.currentSession = this.sessionStore.load(command.identifier);
          this.recoverCurrentSession();
          this.renderer.renderInfo("Resumed session " + this.shortSessionId() + ".");
          return;
        case "exit":
          this.exiting = true;
          this.renderer.renderInfo("Goodbye.");
          return;
      }
    } catch (error) {
      this.writeError(error instanceof Error ? error.message : String(error));
    }
  }

  public abortCurrentTask(): void {
    this.activeAbort?.abort();
  }

  private savePendingTool(call: ToolCall, checkpoint: ToolExecutionCheckpoint): void {
    this.saveSession({
      messages: [...checkpoint.messages],
      usage: checkpoint.usage,
      task: {
        state: "executing_tool",
        limits: checkpoint.limits
      },
      pendingTool: {
        toolCallId: call.id,
        toolName: call.name,
        startedAt: new Date().toISOString()
      }
    });
  }

  private saveToolResult(call: ToolCall, result: ToolResult, checkpoint: ToolExecutionCheckpoint): void {
    void call;
    void result;
    this.saveSession({
      messages: [...checkpoint.messages],
      usage: checkpoint.usage,
      task: {
        state: "recording_results",
        limits: checkpoint.limits
      }
    });
  }

  private saveFinalResult(result: AgentRunResult): void {
    this.saveSession({
      messages: [...result.messages],
      usage: result.usage,
      task: {
        state: result.terminalState,
        terminalState: result.terminalState,
        reason: result.reason,
        message: result.message,
        limits: result.limits
      }
    });
  }

  private saveSession(update: {
    messages: SessionSnapshot["messages"];
    usage?: SessionSnapshot["usage"];
    task: SessionTaskSnapshot;
    pendingTool?: SessionSnapshot["pendingTool"];
  }): void {
    if (this.currentSession === undefined) {
      throw new Error("No active session");
    }
    const {
      pendingTool: _pendingTool,
      usage: _usage,
      task: _task,
      ...base
    } = this.currentSession;
    const next: SessionSnapshot = {
      ...base,
      updatedAt: new Date().toISOString(),
      messages: update.messages,
      task: update.task,
      ...(update.usage === undefined ? {} : { usage: update.usage }),
      ...(update.pendingTool === undefined ? {} : { pendingTool: update.pendingTool })
    };
    this.sessionStore.save(next);
    this.currentSession = next;
  }

  private recoverCurrentSession(): void {
    if (this.currentSession === undefined) {
      return;
    }
    const recovery = recoverPendingTool(this.currentSession);
    if (recovery.warning === undefined) {
      return;
    }
    this.currentSession = recovery.snapshot;
    this.sessionStore.save(recovery.snapshot);
    this.writeError(recovery.warning);
  }

  private writeSessionList(): void {
    const sessions = this.sessionStore.list();
    if (sessions.length === 0) {
      this.renderer.renderInfo("No sessions.");
      return;
    }
    for (const session of sessions) {
      this.renderer.renderInfo(
        session.id.slice(0, 8) +
          "  " +
          session.name +
          "  " +
          session.updatedAt +
          (session.pendingTool === undefined ? "" : "  pending:" + session.pendingTool.toolName) +
          ""
      );
    }
  }

  private async readLine(): Promise<string | undefined> {
    const controller = new AbortController();
    const onProcessInterrupt = () => controller.abort();
    if (this.isInteractive) {
      process.once("SIGINT", onProcessInterrupt);
    }
    try {
      return await this.readNextLine("picode> ", this.output, controller.signal);
    } catch {
      if (controller.signal.aborted) {
        this.renderer.renderInfo("^C");
        return "";
      }
      return undefined;
    } finally {
      if (this.isInteractive) {
        process.removeListener("SIGINT", onProcessInterrupt);
      }
    }
  }

  private async askSharedQuestion(prompt: string, signal?: AbortSignal): Promise<string> {
    const answer = await this.readNextLine(prompt, this.errorOutput, signal);
    if (answer === undefined) {
      throw new Error("Input ended during command approval");
    }
    return answer;
  }

  private async readNextLine(
    prompt: string,
    promptOutput: Writable,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    if (signal?.aborted) {
      throw new Error("Input was aborted");
    }
    const lineIterator = this.ensureLineReader();
    promptOutput.write(prompt);
    let removeAbortListener: (() => void) | undefined;
    let abortPromise: Promise<never> | undefined;
    if (signal !== undefined) {
      abortPromise = new Promise<never>((_resolve, reject) => {
        const onAbort = () => {
          this.closeLineReader();
          reject(new Error("Input was aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      });
    }
    try {
      const next = abortPromise === undefined
        ? await lineIterator.next()
        : await Promise.race([lineIterator.next(), abortPromise]);
      if (next.done) {
        this.closeLineReader();
        return undefined;
      }
      return next.value;
    } finally {
      removeAbortListener?.();
    }
  }

  private ensureLineReader(): AsyncIterator<string> {
    if (this.lineIterator !== undefined) {
      return this.lineIterator;
    }
    const lineInterface = createInterface({
      input: this.input,
      output: this.output,
      terminal: this.isInteractive
    });
    this.lineInterface = lineInterface;
    this.lineIterator = lineInterface[Symbol.asyncIterator]();
    return this.lineIterator;
  }

  private closeLineReader(): void {
    this.lineInterface?.close();
    this.lineInterface = undefined;
    this.lineIterator = undefined;
  }

  private recoverCurrentSessionOrThrow(): void {
    if (this.currentSession === undefined) {
      throw new Error("No active session");
    }
  }

  private shortSessionId(): string {
    this.recoverCurrentSessionOrThrow();
    return this.currentSession!.id.slice(0, 8);
  }

  private writeError(message: string): void {
    this.renderer.renderError(message);
  }
}
