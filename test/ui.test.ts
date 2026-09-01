import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { DEFAULT_MAX_OUTPUT_TOKENS, type PicodeConfig } from "../src/config.js";
import type { AssistantMessage, ToolCall } from "../src/domain/messages.js";
import { ScriptedLlmProvider, type LlmResponse } from "../src/llm/provider.js";
import { SessionStore, type SessionSnapshot } from "../src/sessions/index.js";
import {
  TerminalApp,
  TerminalBusyError,
  exitCodeForTerminalState
} from "../src/ui/index.js";
import { CliCommandError, parseCliCommand } from "../src/ui/index.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class CaptureWritable extends Writable {
  public readonly chunks: string[] = [];

  public override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.chunks.push(String(chunk));
    callback();
  }

  public get text(): string {
    return this.chunks.join("");
  }
}

class RecordingSessionStore extends SessionStore {
  public readonly snapshots: SessionSnapshot[] = [];

  public override save(snapshot: SessionSnapshot): void {
    super.save(snapshot);
    this.snapshots.push(snapshot);
  }
}

function finishResponse(): LlmResponse {
  const call: ToolCall = {
    id: "finish-1",
    name: "finish",
    rawArguments: JSON.stringify({
      status: "success",
      summary: "done",
      verification: "scripted verification",
      remainingIssues: ""
    }),
    arguments: {
      status: "success",
      summary: "done",
      verification: "scripted verification",
      remainingIssues: ""
    }
  };
  const message: AssistantMessage = {
    role: "assistant",
    content: "",
    toolCalls: [call],
    finishReason: "tool_calls"
  };
  return { message };
}

function textResponse(text: string): LlmResponse {
  return {
    message: {
      role: "assistant",
      content: text,
      toolCalls: [],
      finishReason: "stop"
    }
  };
}

function toolResponse(call: ToolCall): LlmResponse {
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [call],
      finishReason: "tool_calls"
    }
  };
}

function createConfig(overrides: Partial<PicodeConfig> = {}): PicodeConfig {
  return {
    apiKey: "ui-test-secret",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    contextWindow: 128_000,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    maxLlmRequests: 30,
    ...overrides
  };
}

function createApp(
  workspaceRoot: string,
  sessionRoot: string,
  provider: ScriptedLlmProvider,
  output = new CaptureWritable(),
  errorOutput = new CaptureWritable(),
  input = new PassThrough(),
  isInteractive = false,
  configOverrides: Partial<PicodeConfig> = {}
): { app: TerminalApp; store: SessionStore; output: CaptureWritable; errorOutput: CaptureWritable } {
  const store = new SessionStore({
    workspaceRoot,
    rootDir: sessionRoot,
    redactionSecrets: ["ui-test-secret"]
  });
  return {
    app: new TerminalApp({
      workspaceRoot,
      config: createConfig(configOverrides),
      provider,
      sessionStore: store,
      input,
      output,
      errorOutput,
      isInteractive
    }),
    store,
    output,
    errorOutput
  };
}

describe("slash commands and terminal task lifecycle", () => {
  it("parses the supported commands and rejects malformed commands", () => {
    expect(parseCliCommand("fix the bug")).toEqual({ kind: "task", text: "fix the bug" });
    expect(parseCliCommand("/new demo session")).toEqual({
      kind: "new_session",
      name: "demo session"
    });
    expect(parseCliCommand("/sessions")).toEqual({ kind: "list_sessions" });
    expect(parseCliCommand("/resume abc123")).toEqual({
      kind: "resume_session",
      identifier: "abc123"
    });
    expect(parseCliCommand("/exit")).toEqual({ kind: "exit" });
    expect(() => parseCliCommand("/resume")).toThrowError(CliCommandError);
    expect(() => parseCliCommand("/unknown")).toThrowError(CliCommandError);
  });

  it("persists the completed task and maps every terminal state to its CLI exit code", async () => {
    const workspace = temporaryDirectory("picode-ui-workspace-");
    const root = temporaryDirectory("picode-ui-root-");
    const { app, store, output } = createApp(
      workspace,
      root,
      new ScriptedLlmProvider([{ response: finishResponse() }])
    );

    await app.initialize({ newSession: true });
    const result = await app.runTask("finish this task");
    const session = app.getSession()!;
    const saved = store.load(session.id);

    expect(result.terminalState).toBe("completed");
    expect(result).not.toHaveProperty("state");
    expect(saved.task).toMatchObject({
      state: "completed",
      terminalState: "completed",
      reason: "finish_success"
    });
    expect(saved.pendingTool).toBeUndefined();
    expect(saved.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "finish-1" });
    expect(output.text).toContain("[completed]");
    expect(exitCodeForTerminalState("completed")).toBe(0);
    expect(exitCodeForTerminalState("partial")).toBe(2);
    expect(exitCodeForTerminalState("failed")).toBe(3);
    expect(exitCodeForTerminalState("limit_reached")).toBe(4);
    expect(exitCodeForTerminalState("aborted")).toBe(130);
  });

  it("persists a pending marker before a tool and clears it after the result", async () => {
    const workspace = temporaryDirectory("picode-ui-pending-workspace-");
    const root = temporaryDirectory("picode-ui-pending-root-");
    const store = new RecordingSessionStore({
      workspaceRoot: workspace,
      rootDir: root,
      redactionSecrets: ["ui-test-secret"]
    });
    const output = new CaptureWritable();
    const errorOutput = new CaptureWritable();
    const app = new TerminalApp({
      workspaceRoot: workspace,
      config: createConfig(),
      provider: new ScriptedLlmProvider([{ response: finishResponse() }]),
      sessionStore: store,
      input: new PassThrough(),
      output,
      errorOutput,
      isInteractive: false
    });

    await app.initialize({ newSession: true });
    await app.runTask("persist the tool boundary");

    const pendingIndex = store.snapshots.findIndex(
      (snapshot) => snapshot.pendingTool?.toolCallId === "finish-1"
    );
    expect(pendingIndex).toBeGreaterThanOrEqual(0);
    const completedSnapshot = store.snapshots
      .slice(pendingIndex + 1)
      .find((snapshot) => snapshot.pendingTool === undefined && snapshot.messages.some(
        (message) => message.role === "tool" && message.toolCallId === "finish-1"
      ));
    expect(completedSnapshot).toBeDefined();
  });

  it("recovers a pending tool before enforcing repeated-call termination", async () => {
    const workspace = temporaryDirectory("picode-ui-recovery-workspace-");
    const root = temporaryDirectory("picode-ui-recovery-root-");
    const seedStore = new SessionStore({
      workspaceRoot: workspace,
      rootDir: root,
      redactionSecrets: ["ui-test-secret"]
    });
    const session = seedStore.create("recovery and limits");
    const pendingCall: ToolCall = {
      id: "crashed-write",
      name: "write_file",
      rawArguments: JSON.stringify({ path: "recovered.txt", content: "crash" }),
      arguments: { path: "recovered.txt", content: "crash" }
    };
    const pendingAssistant: AssistantMessage = {
      role: "assistant",
      content: "",
      toolCalls: [pendingCall],
      finishReason: "tool_calls"
    };
    seedStore.save({
      ...session,
      messages: [pendingAssistant],
      task: { state: "executing_tool" },
      pendingTool: {
        toolCallId: pendingCall.id,
        toolName: pendingCall.name,
        startedAt: new Date().toISOString()
      }
    });

    const retryCall = (id: string): ToolCall => ({
      id,
      name: "write_file",
      rawArguments: JSON.stringify({ path: "recovered.txt", content: "retry" }),
      arguments: { path: "recovered.txt", content: "retry" }
    });
    const provider = new ScriptedLlmProvider([
      { response: toolResponse(retryCall("retry-1")) },
      { response: toolResponse(retryCall("retry-2")) },
      { response: toolResponse(retryCall("retry-3")) }
    ]);
    const { app, store } = createApp(workspace, root, provider);
    const recovered = await app.initialize();
    const target = join(workspace, "recovered.txt");

    expect(recovered.pendingTool).toBeUndefined();
    expect(recovered.task).toMatchObject({
      state: "aborted",
      terminalState: "aborted",
      reason: "aborted"
    });
    expect(recovered.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "crashed-write"
    });
    expect(existsSync(target)).toBe(false);

    const result = await app.runTask("retry the recovered write");
    const saved = store.load(recovered.id);
    const toolMessages = result.messages.filter((message) => message.role === "tool");

    expect(result.terminalState).toBe("limit_reached");
    expect(result.reason).toBe("limit_reached");
    expect(provider.requests).toHaveLength(3);
    expect(readFileSync(target, "utf8")).toBe("retry");
    expect(toolMessages.map((message) => message.toolCallId)).toEqual([
      "crashed-write",
      "retry-1",
      "retry-2",
      "retry-3"
    ]);
    expect(toolMessages[0]?.content).toContain("side-effect state is unknown");
    expect(toolMessages.at(-1)?.content).toContain("batch_rejected");
    expect(saved.task).toMatchObject({
      state: "limit_reached",
      terminalState: "limit_reached",
      reason: "limit_reached"
    });
  });

  it("supports new/list/resume/exit and refuses session changes while busy", async () => {
    const workspace = temporaryDirectory("picode-ui-command-workspace-");
    const root = temporaryDirectory("picode-ui-command-root-");
    const provider = new ScriptedLlmProvider([
      { response: textResponse("working"), delayMs: 30 },
      { response: finishResponse() }
    ]);
    const { app, output, errorOutput } = createApp(workspace, root, provider);

    await app.handleLine("/new first session");
    const firstId = app.getSession()!.id;
    await app.handleLine("/new second session");
    expect(app.getSession()!.name).toBe("second session");
    await app.handleLine("/resume " + firstId.slice(0, 8));
    expect(app.getSession()!.id).toBe(firstId);
    await app.handleLine("/sessions");
    expect(output.text).toContain("first session");
    expect(output.text).toContain("second session");

    const running = app.runTask("run while busy");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(app.isBusy()).toBe(true);
    await expect(app.runTask("second task")).rejects.toBeInstanceOf(TerminalBusyError);
    await app.handleLine("/new should-not-switch");
    expect(app.getSession()!.id).toBe(firstId);
    expect(errorOutput.text).toContain("busy");
    await running;
    expect(app.isBusy()).toBe(false);

    await app.handleLine("/exit");
    expect(output.text).toContain("Goodbye.");
  });

  it("runs a single task through the main CLI composition and returns the finish exit code", async () => {
    const startupDir = temporaryDirectory("picode-cli-phase4-startup-");
    const workspace = temporaryDirectory("picode-cli-phase4-workspace-");
    const root = temporaryDirectory("picode-cli-phase4-root-");
    const output = new CaptureWritable();
    const errorOutput = new CaptureWritable();
    const result = main(["--cwd", workspace, "finish", "from", "cli"], {
      startupDir,
      env: {
        PICODE_API_KEY: "ui-test-secret",
        PICODE_MODEL: "test-model"
      },
      input: new PassThrough(),
      stdout: output,
      stderr: errorOutput,
      sessionRoot: root,
      provider: new ScriptedLlmProvider([{ response: finishResponse() }]),
      isInteractive: false
    });
    const exitCode = typeof result === "number" ? result : await result;

    expect(exitCode).toBe(0);
    expect(errorOutput.text).toContain("usage was unavailable");
    expect(errorOutput.text).not.toContain("ui-test-secret");
    expect(output.text).toContain("[completed]");
    const projects = readdirSync(join(root, "projects"));
    expect(projects).toHaveLength(1);
    expect(readdirSync(join(root, "projects", projects[0]!, "sessions"))).toHaveLength(1);
  });

  it("applies the configured per-task LLM request limit through the CLI", async () => {
    const startupDir = temporaryDirectory("picode-cli-limit-startup-");
    const workspace = temporaryDirectory("picode-cli-limit-workspace-");
    const root = temporaryDirectory("picode-cli-limit-root-");
    const output = new CaptureWritable();
    const errorOutput = new CaptureWritable();
    const provider = new ScriptedLlmProvider([
      { response: textResponse("first attempt") },
      { response: textResponse("second attempt") }
    ]);

    const result = main(["--cwd", workspace, "keep working"], {
      startupDir,
      env: {
        PICODE_API_KEY: "ui-test-secret",
        PICODE_MAX_LLM_REQUESTS: "2"
      },
      input: new PassThrough(),
      stdout: output,
      stderr: errorOutput,
      sessionRoot: root,
      provider,
      isInteractive: false
    });
    const exitCode = typeof result === "number" ? result : await result;

    expect(exitCode).toBe(4);
    expect(provider.requests).toHaveLength(2);
    expect(output.text).toContain("[limit_reached]");
    expect(errorOutput.text).toContain("usage was unavailable");
  });

  it("drives the interactive readline loop until /exit", async () => {
    const workspace = temporaryDirectory("picode-ui-interactive-workspace-");
    const root = temporaryDirectory("picode-ui-interactive-root-");
    const input = new PassThrough();
    const output = new CaptureWritable();
    const errorOutput = new CaptureWritable();
    const { app } = createApp(
      workspace,
      root,
      new ScriptedLlmProvider([]),
      output,
      errorOutput,
      input
    );

    const running = app.runInteractive();
    input.end("/sessions\n/exit\n");
    const exitCode = await running;

    expect(exitCode).toBe(0);
    expect(output.text).toContain("New session");
    expect(output.text).toContain("Goodbye.");
  });

  it("keeps the interactive prompt when readline redraws after backspace", async () => {
    const workspace = temporaryDirectory("picode-ui-edit-workspace-");
    const root = temporaryDirectory("picode-ui-edit-root-");
    const input = new PassThrough();
    const output = new CaptureWritable();
    const errorOutput = new CaptureWritable();
    const { app } = createApp(
      workspace,
      root,
      new ScriptedLlmProvider([{ response: finishResponse() }]),
      output,
      errorOutput,
      input,
      true
    );

    const running = app.runInteractive();
    input.end("ab\x7f\n/exit\n");
    await running;

    expect(output.text.match(/picode> /g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps approval input exclusive from the ordinary command reader", async () => {
    const workspace = temporaryDirectory("picode-ui-approval-workspace-");
    const root = temporaryDirectory("picode-ui-approval-root-");
    const input = new PassThrough();
    const output = new CaptureWritable();
    const errorOutput = new CaptureWritable();
    const { app } = createApp(
      workspace,
      root,
      new ScriptedLlmProvider([
        {
          response: {
            message: {
              role: "assistant",
              content: "",
              toolCalls: [{
                id: "command-1",
                name: "run_command",
                rawArguments: JSON.stringify({ command: "true" }),
                arguments: { command: "true" }
              }],
              finishReason: "tool_calls"
            }
          }
        },
        { response: finishResponse() }
      ]),
      output,
      errorOutput,
      input,
      true
    );

    const running = app.runInteractive();
    input.end("run the approved command\n y\n/exit\n");
    await running;

    expect(errorOutput.text).toContain("Allow this command?");
    expect(output.text).toContain("[completed]");
    expect(output.text).toContain("Goodbye.");
  });
});
