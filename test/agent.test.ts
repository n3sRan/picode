import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentLoop, type MonotonicClock } from "../src/agent/index.js";
import { BudgetTracker } from "../src/context/index.js";
import type { AssistantMessage, JsonObject, LlmUsage, Message, ToolCall } from "../src/domain/messages.js";
import type { LlmProvider, LlmRequest, LlmResponse } from "../src/llm/provider.js";
import { ScriptedLlmProvider } from "../src/llm/provider.js";
import { TestApprovalBroker, type ApprovalBroker, type ApprovalRequest } from "../src/security/approval.js";
import { PathPolicy } from "../src/security/path-policy.js";
import { createBuiltinToolRegistry } from "../src/tools/index.js";
import { finishTool } from "../src/tools/finish.js";
import { runCommandTool } from "../src/tools/run-command.js";
import { createValidator, type JsonSchema } from "../src/tools/validators.js";
import type {
  ShellRunRequest,
  ShellRunResult,
  ShellRunner,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult
} from "../src/tools/types.js";
import { ToolRegistry } from "../src/tools/registry.js";

const createdDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  createdDirectories.push(directory);
  return directory;
}

function makeContext(approvalBroker: ApprovalBroker = new TestApprovalBroker()): ToolExecutionContext & { workspace: string; session: string } {
  const workspace = temporaryDirectory("picode-agent-workspace-");
  const session = temporaryDirectory("picode-agent-session-");
  const pathPolicy = new PathPolicy({
    workspaceRoot: workspace,
    sessionId: "agent-test-session",
    sessionTmpDir: session
  });
  return {
    workspaceRoot: workspace,
    sessionId: "agent-test-session",
    sessionTmpDir: session,
    pathPolicy,
    approvalBroker,
    workspace,
    session
  };
}

afterEach(() => {
  while (createdDirectories.length > 0) {
    const directory = createdDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

function call(id: string, name: string, args: JsonObject): ToolCall {
  return { id, name, rawArguments: JSON.stringify(args), arguments: args };
}

function assistant(toolCalls: readonly ToolCall[] = [], content = ""): LlmResponse {
  const message: AssistantMessage = {
    role: "assistant",
    content,
    toolCalls: [...toolCalls],
    finishReason: toolCalls.length === 0 ? "stop" : "tool_calls"
  };
  return { message };
}

function finishResponse(status: "success" | "partial" | "failure" = "success"): LlmResponse {
  return assistant([
    call("finish-call", "finish", {
      status,
      summary: `${status} summary`,
      verification: "deterministic test verification",
      remainingIssues: status === "success" ? "" : "known issue"
    })
  ]);
}

const valueSchema: JsonSchema = {
  type: "object",
  properties: { value: { type: "integer" } },
  required: ["value"],
  additionalProperties: false
};

interface ValueArgs extends JsonObject {
  value: number;
}

function valueTool(
  name: string,
  execute: (context: ToolExecutionContext, args: ValueArgs, signal: AbortSignal) => Promise<ToolResult>
): ToolDefinition<ValueArgs> {
  return {
    name,
    description: `Test tool ${name}`,
    parameters: valueSchema,
    validate: createValidator<ValueArgs>(valueSchema),
    execute
  };
}

const successfulShellResult: ShellRunResult = {
  status: "completed",
  stdout: "test command output",
  stderr: "",
  exitCode: 0,
  signal: null,
  durationMs: 1,
  stdoutTruncated: false,
  stderrTruncated: false
};

class FakeShellRunner implements ShellRunner {
  public readonly requests: ShellRunRequest[] = [];

  public async run(request: ShellRunRequest): Promise<ShellRunResult> {
    this.requests.push(request);
    return successfulShellResult;
  }
}

class FakeClock implements MonotonicClock {
  public current = 0;

  public now(): number {
    return this.current;
  }

  public advance(milliseconds: number): void {
    this.current += milliseconds;
  }
}

class AdvancingApprovalBroker implements ApprovalBroker {
  public readonly requests: ApprovalRequest[] = [];

  public constructor(private readonly clock: FakeClock, private readonly delayMs: number) {}

  public async requestApproval(request: ApprovalRequest): Promise<boolean> {
    this.requests.push(request);
    this.clock.advance(this.delayMs);
    return true;
  }
}

describe("AgentLoop flow and tool batching", () => {
  it("completes the scripted read-edit-command-finish flow and preserves tool pairs", async () => {
    const context = makeContext(new TestApprovalBroker([true]));
    writeFileSync(join(context.workspace, "bug.txt"), "old value\n");
    const shellRunner = new FakeShellRunner();
    context.shellRunner = shellRunner;
    const provider = new ScriptedLlmProvider([
      { response: assistant([call("read-1", "read_file", { path: "bug.txt" })]) },
      { response: assistant([call("edit-1", "edit_file", { path: "bug.txt", oldText: "old", newText: "new" })]) },
      { response: assistant([call("command-1", "run_command", { command: "printf verified" })]) },
      { response: finishResponse() }
    ]);
    const loop = new AgentLoop({
      provider,
      tools: createBuiltinToolRegistry(),
      toolContext: context
    });

    const result = await loop.run("Fix the bug and verify it.");

    expect(result.terminalState).toBe("completed");
    expect(result.reason).toBe("finish_success");
    expect(provider.requests).toHaveLength(4);
    expect(readFileSync(join(context.workspace, "bug.txt"), "utf8")).toBe("new value\n");
    expect(shellRunner.requests).toHaveLength(1);
    expect(result.messages.filter((message): message is Extract<Message, { role: "tool" }> => message.role === "tool").map((message) => message.toolCallId)).toEqual([
      "read-1",
      "edit-1",
      "command-1",
      "finish-call"
    ]);
    expect(result.events.some((event) => event.type === "approval_requested")).toBe(true);
    expect(result.events.at(-1)).toMatchObject({ type: "agent_terminated", state: "completed" });
  });

  it("executes a multi-tool batch strictly serially", async () => {
    const order: string[] = [];
    const first = valueTool("first", async (_context, args) => {
      order.push(`first:start:${args.value}`);
      await Promise.resolve();
      order.push("first:end");
      return { status: "ok", content: "first complete" };
    });
    const second = valueTool("second", async (_context, args) => {
      order.push(`second:start:${args.value}`);
      order.push("second:end");
      return { status: "ok", content: "second complete" };
    });
    const provider = new ScriptedLlmProvider([
      { response: assistant([call("first-1", "first", { value: 1 }), call("second-1", "second", { value: 2 })]) },
      { response: finishResponse() }
    ]);
    const result = await new AgentLoop({
      provider,
      tools: new ToolRegistry([first, second, finishTool]),
      toolContext: makeContext()
    }).run("run both");

    expect(result.terminalState).toBe("completed");
    expect(order).toEqual(["first:start:1", "first:end", "second:start:2", "second:end"]);
  });

  it("rejects an invalid batch without side effects and fills every tool result", async () => {
    let executions = 0;
    const sideEffect = valueTool("side_effect", async () => {
      executions += 1;
      return { status: "ok", content: "should not run" };
    });
    const provider = new ScriptedLlmProvider([
      {
        response: assistant([
          call("valid-1", "side_effect", { value: 1 }),
          call("invalid-1", "missing_tool", {})
        ])
      },
      { response: finishResponse() }
    ]);
    const result = await new AgentLoop({
      provider,
      tools: new ToolRegistry([sideEffect, finishTool]),
      toolContext: makeContext()
    }).run("validate the batch");

    expect(result.terminalState).toBe("completed");
    expect(executions).toBe(0);
    const toolMessages = result.messages.filter((message): message is Extract<Message, { role: "tool" }> => message.role === "tool");
    expect(toolMessages).toHaveLength(3);
    expect(toolMessages[0]?.content).toContain("batch_rejected");
    expect(toolMessages[1]?.content).toContain("unknown tool");
    expect(toolMessages[2]?.toolCallId).toBe("finish-call");
  });

  it("rejects mixed finish calls before executing the other call", async () => {
    let executions = 0;
    const sideEffect = valueTool("side_effect", async () => {
      executions += 1;
      return { status: "ok", content: "should not run" };
    });
    const provider = new ScriptedLlmProvider([
      {
        response: assistant([
          call("finish-mixed", "finish", {
            status: "success",
            summary: "wrong batch",
            verification: "not run",
            remainingIssues: ""
          }),
          call("side-1", "side_effect", { value: 1 })
        ])
      },
      { response: finishResponse() }
    ]);
    const result = await new AgentLoop({
      provider,
      tools: new ToolRegistry([sideEffect, finishTool]),
      toolContext: makeContext()
    }).run("reject mixed finish");

    expect(result.terminalState).toBe("completed");
    expect(executions).toBe(0);
    expect(result.messages.some((message) => message.role === "tool" && message.toolCallId === "finish-mixed" && message.content.includes("finish must be the only"))).toBe(true);
  });

  it.each([
    ["success", "completed", "finish_success"],
    ["partial", "partial", "finish_partial"],
    ["failure", "failed", "finish_failure"]
  ] as const)("maps finish status %s to the terminal protocol", async (finishStatus, state, reason) => {
    const result = await new AgentLoop({
      provider: new ScriptedLlmProvider([{ response: finishResponse(finishStatus) }]),
      tools: new ToolRegistry([finishTool]),
      toolContext: makeContext()
    }).run("finish now");

    expect(result.terminalState).toBe(state);
    expect(result.reason).toBe(reason);
    expect(result.finish?.status).toBe(finishStatus);
    expect(result.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "finish-call" });
    expect(result.messages.at(-1)?.content).toContain('"accepted":true');
  });

  it("completes a direct answer in one request with a status-only finish call", async () => {
    const provider = new ScriptedLlmProvider([
      { response: assistant([call("finish-answer", "finish", { status: "success" })], "Here is the answer.") }
    ]);
    const result = await new AgentLoop({
      provider,
      tools: new ToolRegistry([finishTool]),
      toolContext: makeContext()
    }).run("What can you do?");

    expect(result.terminalState).toBe("completed");
    expect(result.reason).toBe("finish_success");
    expect(result.finish).toEqual({
      status: "success",
      summary: "Task completed.",
      verification: "No verification details provided.",
      remainingIssues: ""
    });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("call the finish tool exactly once")
    });
    expect(result.messages.at(-1)?.content).toContain('"summary":"Task completed."');
  });
});

describe("AgentLoop limits and cancellation", () => {
  it("fails after three text-only turns and sends protocol reminders first", async () => {
    const provider = new ScriptedLlmProvider([
      { response: assistant([], "first text") },
      { response: assistant([], "second text") },
      { response: assistant([], "third text") }
    ]);
    const result = await new AgentLoop({
      provider,
      tools: new ToolRegistry([finishTool]),
      toolContext: makeContext(),
      limits: { maxNoFinishTurns: 3 }
    }).run("do not finish");

    expect(result.terminalState).toBe("failed");
    expect(result.reason).toBe("protocol_error");
    expect(provider.requests).toHaveLength(3);
    expect(result.messages.filter((message) => message.role === "user").map((message) => message.content)).toContain("Protocol reminder: do not end this task with text alone. If the task is complete, call finish now; otherwise use the provided tools.");
    expect(result.limits.consecutiveNoFinishTurns).toBe(3);
  });

  it("stops before executing the third identical call", async () => {
    let executions = 0;
    const repeated = valueTool("repeatable", async () => {
      executions += 1;
      return { status: "ok", content: "ran" };
    });
    const provider = new ScriptedLlmProvider([
      { response: assistant([call("repeat-1", "repeatable", { value: 1 })]) },
      { response: assistant([call("repeat-2", "repeatable", { value: 1 })]) },
      { response: assistant([call("repeat-3", "repeatable", { value: 1 })]) }
    ]);
    const result = await new AgentLoop({
      provider,
      tools: new ToolRegistry([repeated, finishTool]),
      toolContext: makeContext()
    }).run("repeat");

    expect(executions).toBe(2);
    expect(result.terminalState).toBe("limit_reached");
    expect(result.reason).toBe("limit_reached");
    expect(result.messages.at(-1)?.content).toContain("batch_rejected");
  });

  it("stops after three consecutive errors and skips the rest of the batch", async () => {
    let executions = 0;
    const failing = valueTool("failing", async () => {
      executions += 1;
      return { status: "error", content: "expected failure" };
    });
    const provider = new ScriptedLlmProvider([
      {
        response: assistant([
          call("error-1", "failing", { value: 1 }),
          call("error-2", "failing", { value: 2 }),
          call("error-3", "failing", { value: 3 }),
          call("error-4", "failing", { value: 4 })
        ])
      }
    ]);
    const result = await new AgentLoop({
      provider,
      tools: new ToolRegistry([failing, finishTool]),
      toolContext: makeContext()
    }).run("fail three times");

    expect(executions).toBe(3);
    expect(result.terminalState).toBe("limit_reached");
    expect(result.messages.at(-1)?.content).toContain("batch_rejected");
  });

  it("enforces the request limit before sending another LLM request", async () => {
    const provider = new ScriptedLlmProvider([
      { response: assistant([], "one") },
      { response: assistant([], "two") }
    ]);
    const result = await new AgentLoop({
      provider,
      tools: new ToolRegistry([finishTool]),
      toolContext: makeContext(),
      limits: { maxLlmRequests: 2, maxNoFinishTurns: 20 }
    }).run("limited");

    expect(provider.requests).toHaveLength(2);
    expect(result.terminalState).toBe("limit_reached");
    expect(result.limits.llmRequestCount).toBe(2);
  });

  it("excludes approval wait from active time", async () => {
    const clock = new FakeClock();
    const approval = new AdvancingApprovalBroker(clock, 100);
    const context = makeContext(approval);
    context.shellRunner = new FakeShellRunner();
    const result = await new AgentLoop({
      provider: new ScriptedLlmProvider([
        { response: assistant([call("command-1", "run_command", { command: "printf ok" })]) },
        { response: finishResponse() }
      ]),
      tools: new ToolRegistry([runCommandTool, finishTool]),
      toolContext: context,
      limits: { maxActiveMs: 50 },
      clock
    }).run("approve then finish");

    expect(result.terminalState).toBe("completed");
    expect(result.limits.activeElapsedMs).toBe(0);
    expect(approval.requests).toHaveLength(1);
  });

  it("enforces active time after a tool advances the clock and handles Ctrl+C", async () => {
    const clock = new FakeClock();
    const advancing = valueTool("advance", async () => {
      clock.advance(100);
      return { status: "ok", content: "advanced" };
    });
    const limited = await new AgentLoop({
      provider: new ScriptedLlmProvider([{ response: assistant([call("advance-1", "advance", { value: 1 })]) }]),
      tools: new ToolRegistry([advancing, finishTool]),
      toolContext: makeContext(),
      limits: { maxActiveMs: 50 },
      clock
    }).run("advance");
    expect(limited.terminalState).toBe("limit_reached");
    expect(limited.limits.activeElapsedMs).toBe(100);

    const controller = new AbortController();
    const cancellable = new AgentLoop({
      provider: new ScriptedLlmProvider([{ response: assistant([], "slow"), delayMs: 100 }]),
      tools: new ToolRegistry([finishTool]),
      toolContext: makeContext()
    });
    const run = cancellable.run("cancel", controller.signal);
    setTimeout(() => controller.abort(), 10);
    const aborted = await run;
    expect(aborted.terminalState).toBe("aborted");
    expect(aborted.reason).toBe("aborted");
  });
});

describe("BudgetTracker", () => {
  it("warns at 75 percent, stops at 90 percent, and falls back when usage is missing", () => {
    const budget = new BudgetTracker({ contextWindow: 1_000, charsPerToken: 1 });
    const initial: Message[] = [{ role: "user", content: "x".repeat(650) }];
    budget.recordUsage({ promptTokens: 650 }, initial);

    const warning = budget.beforeRequest([
      ...initial,
      { role: "tool", toolCallId: "tool-1", toolName: "test", content: "y".repeat(100) }
    ]);
    expect(warning.allowed).toBe(true);
    expect(warning.ratio).toBeGreaterThanOrEqual(0.75);
    expect(warning.warning).toContain("context usage");

    const stopped = budget.beforeRequest([
      ...initial,
      { role: "tool", toolCallId: "tool-1", toolName: "test", content: "y".repeat(300) }
    ]);
    expect(stopped.allowed).toBe(false);
    expect(stopped.ratio).toBeGreaterThanOrEqual(0.9);

    const missing = new BudgetTracker({ contextWindow: 1_000, charsPerToken: 1 });
    const fallback = missing.beforeRequest(initial);
    expect(fallback.usedFallbackEstimate).toBe(true);
    expect(fallback.warning).toContain("usage was unavailable");
    expect(missing.beforeRequest(initial).warning).toBeUndefined();
  });

  it("counts the assistant response after the prompt usage anchor", () => {
    const budget = new BudgetTracker({ contextWindow: 1_000, charsPerToken: 1 });
    const prompt: Message[] = [{ role: "user", content: "x".repeat(100) }];
    budget.recordUsage({ promptTokens: 100 }, prompt);

    const nextContext: Message[] = [
      ...prompt,
      {
        role: "assistant",
        content: "a".repeat(500),
        toolCalls: [],
        finishReason: "stop"
      }
    ];
    const decision = budget.beforeRequest(nextContext);

    expect(decision.estimatedTokens).toBeGreaterThanOrEqual(600);
  });
});
