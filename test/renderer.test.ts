import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/domain/events.js";
import { TerminalRenderer } from "../src/ui/index.js";

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

function toolCall() {
  return {
    id: "call-1",
    name: "read_file",
    rawArguments: JSON.stringify({ path: "src/index.ts" }),
    arguments: { path: "src/index.ts" }
  } as const;
}

describe("TerminalRenderer", () => {
  it("renders event categories as readable non-TTY blocks", () => {
    const output = new CaptureWritable();
    const errorOutput = new CaptureWritable();
    const renderer = new TerminalRenderer({ output, errorOutput, color: false });
    const events: AgentEvent[] = [
      { type: "state_changed", state: "streaming" },
      { type: "assistant_text_delta", delta: "I found the issue." },
      { type: "llm_usage_received", usage: { promptTokens: 42, completionTokens: 8, totalTokens: 50 } },
      {
        type: "assistant_message_completed",
        message: {
          role: "assistant",
          content: "I found the issue.",
          toolCalls: [toolCall()],
          finishReason: "tool_calls"
        }
      },
      { type: "tool_requested", toolCall: toolCall() },
      {
        type: "approval_requested",
        command: "pytest -q",
        cwd: "/tmp/project",
        timeoutMs: 60_000,
        riskNote: "Runs with the current user's permissions."
      },
      { type: "approval_resolved", approved: true },
      { type: "tool_completed", toolCallId: "call-1", status: "ok", summary: "Read 12 lines." },
      { type: "context_warning", message: "Context usage is high", ratio: 0.75 },
      {
        type: "agent_terminated",
        state: "completed",
        reason: "finish_success",
        message: "Task completed."
      }
    ];

    for (const event of events) {
      renderer.render(event);
    }

    expect(output.text).not.toContain("\u001b[");
    expect(output.text).toContain("[assistant]\nI found the issue.");
    expect(output.text).toContain("[usage] request=1 prompt_tokens=42 completion_tokens=8 total_tokens=50");
    expect(output.text).toContain("[tool] read_file");
    expect(output.text).toContain("arguments: {\"path\":\"src/index.ts\"}");
    expect(output.text).toContain("[approval] confirmation required");
    expect(output.text).toContain("[approval] approved");
    expect(output.text).toContain("[tool result] read_file ok");
    expect(output.text).toContain("[completed] Task completed.");
    expect(errorOutput.text).toContain("picode: [warning] Context usage is high (75%)");

    expect(output.text.indexOf("[assistant]")).toBeLessThan(output.text.indexOf("[tool] read_file"));
    expect(output.text.indexOf("[tool] read_file")).toBeLessThan(output.text.indexOf("[tool result] read_file ok"));
  });

  it("uses ANSI colors only when explicitly enabled", () => {
    const coloredOutput = new CaptureWritable();
    const coloredRenderer = new TerminalRenderer({
      output: coloredOutput,
      errorOutput: new CaptureWritable(),
      color: true
    });
    coloredRenderer.render({ type: "assistant_text_delta", delta: "hello" });
    expect(coloredOutput.text).toContain("\u001b[36m[assistant]\u001b[0m");

    const plainOutput = new CaptureWritable();
    const plainRenderer = new TerminalRenderer({
      output: plainOutput,
      errorOutput: new CaptureWritable(),
      color: false
    });
    plainRenderer.render({ type: "assistant_text_delta", delta: "hello" });
    expect(plainOutput.text).toBe("[assistant]\nhello");
  });
});
