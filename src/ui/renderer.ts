import type { Writable } from "node:stream";
import type { ContextUsage } from "../domain/context.js";
import type { AgentEvent } from "../domain/events.js";

type Tone = "assistant" | "tool" | "approval" | "usage" | "success" | "warning" | "error" | "info";

const ANSI_COLORS: Record<Tone, number> = {
  assistant: 36,
  tool: 35,
  approval: 33,
  usage: 34,
  success: 32,
  warning: 33,
  error: 31,
  info: 36
};

const MAX_TOOL_ARGUMENT_LENGTH = 360;
const MAX_DISPLAY_LENGTH = 500;

export interface TerminalRendererOptions {
  output: Writable;
  errorOutput: Writable;
  color?: boolean;
  verbose?: boolean;
}

function isTty(stream: Writable): boolean {
  return (stream as Writable & { isTTY?: boolean }).isTTY === true;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function indent(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
}

function formatContextUsageValue(usage: ContextUsage): string {
  const percent = `${(usage.ratio * 100).toFixed(2).replace(/\.?0+$/, "")}%`;
  const source = usage.source === "fallback_estimate" ? "fallback estimate" : "usage anchor";
  return `${usage.estimatedTokens.toLocaleString("en-US")} tokens (${percent} of ${usage.contextWindow.toLocaleString("en-US")}; ${source})`;
}

function toolArguments(value: Record<string, unknown>): string | undefined {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized === "{}") {
    return undefined;
  }
  return truncate(serialized, MAX_TOOL_ARGUMENT_LENGTH);
}

function resultTone(status: string): Tone {
  return status === "ok" ? "success" : status === "permission_denied" || status === "aborted" || status === "batch_rejected"
    ? "warning"
    : "error";
}

function terminalTone(state: string): Tone {
  return state === "completed" ? "success" : state === "partial" || state === "limit_reached" ? "warning" : "error";
}

/** Renders AgentEvents as structured terminal output without changing runtime state. */
export class TerminalRenderer {
  private readonly output: Writable;
  private readonly errorOutput: Writable;
  private readonly outputColor: boolean;
  private readonly errorColor: boolean;
  private verbose: boolean;
  private assistantTextOpen = false;
  private hasOutput = false;
  private requestCount = 0;
  private readonly toolNames = new Map<string, string>();
  private pendingContextUsage: ContextUsage | undefined;

  public constructor(options: TerminalRendererOptions) {
    this.output = options.output;
    this.errorOutput = options.errorOutput;
    this.outputColor = options.color ?? isTty(this.output);
    this.errorColor = options.color ?? isTty(this.errorOutput);
    this.verbose = options.verbose ?? false;
  }

  public setVerbose(verbose: boolean): void {
    this.verbose = verbose;
  }

  /** Starts a new task's display state while keeping the surrounding session output. */
  public beginTask(): void {
    this.assistantTextOpen = false;
    this.requestCount = 0;
    this.toolNames.clear();
    this.pendingContextUsage = undefined;
  }

  public renderSessionHeader(sessionId: string, name: string): void {
    this.output.write(`${this.paint("picode", "info")} session ${sessionId} (${name})\n`);
    this.hasOutput = true;
  }

  public renderInfo(message: string): void {
    this.output.write(`${this.paint("[info]", "info")} ${message}\n`);
    this.hasOutput = true;
  }

  public renderError(message: string): void {
    this.errorOutput.write(`picode: ${this.paint("[error]", "error", this.errorColor)} ${message}\n`);
  }

  public renderWarning(message: string): void {
    this.errorOutput.write(`picode: ${this.paint("[warning]", "warning", this.errorColor)} ${message}\n`);
  }

  public render(event: AgentEvent): void {
    switch (event.type) {
      case "state_changed":
        if (event.state === "streaming") {
          this.requestCount += 1;
        }
        return;
      case "assistant_text_delta":
        this.renderAssistantText(event.delta);
        return;
      case "assistant_message_completed":
        this.finishAssistantText();
        return;
      case "llm_usage_received": {
        if (!this.verbose) {
          return;
        }
        const usage = [
          `request=${this.requestCount}`,
          `prompt_tokens=${event.usage.promptTokens}`,
          ...(event.usage.completionTokens === undefined ? [] : [`completion_tokens=${event.usage.completionTokens}`]),
          ...(event.usage.totalTokens === undefined ? [] : [`total_tokens=${event.usage.totalTokens}`])
        ].join(" ");
        this.writeBlock("usage", "usage", usage);
        return;
      }
      case "tool_requested": {
        this.toolNames.set(event.toolCall.id, event.toolCall.name);
        if (!this.verbose) {
          return;
        }
        const serializedArguments = toolArguments(event.toolCall.arguments);
        const details = [
          `call_id: ${truncate(event.toolCall.id, MAX_DISPLAY_LENGTH)}`,
          ...(serializedArguments === undefined ? [] : [`arguments: ${serializedArguments}`])
        ];
        this.writeBlock("tool", "tool", event.toolCall.name, details);
        return;
      }
      case "approval_requested":
        this.writeBlock("approval", "approval", "confirmation required", [
          `command: ${truncate(event.command, MAX_DISPLAY_LENGTH)}`,
          `cwd: ${event.cwd}`,
          `risk: ${event.riskNote}`
        ]);
        return;
      case "approval_resolved":
        this.writeBlock(
          "approval",
          event.approved ? "success" : "warning",
          event.approved ? "approved" : "denied"
        );
        return;
      case "tool_completed": {
        const toolName = this.toolNames.get(event.toolCallId) ?? "tool";
        if (!this.verbose) {
          if (toolName === "finish") {
            return;
          }
          this.writeBlock("tool", resultTone(event.status), `${toolName} ${event.status}`);
          return;
        }
        this.writeBlock("tool result", resultTone(event.status), `${toolName} ${event.status}`, [
          `call_id: ${truncate(event.toolCallId, MAX_DISPLAY_LENGTH)}`,
          truncate(event.summary, MAX_DISPLAY_LENGTH)
        ]);
        return;
      }
      case "context_warning":
        this.renderWarning(`${event.message} (${Math.round(event.ratio * 100)}%)`);
        return;
      case "context_usage":
        this.pendingContextUsage = event.usage;
        return;
      case "context_compaction_started":
        this.writeBlock("compact", "info", `${event.mode} context compaction started`);
        return;
      case "context_compacted":
        this.writeBlock("compact", "success", `${event.mode} context compacted`, [
          `before: ${formatContextUsageValue(event.before)}`,
          `after: ${formatContextUsageValue(event.after)}`,
          `removed_messages: ${event.removedMessageCount}`,
          `removed_groups: ${event.removedGroupCount}`
        ]);
        return;
      case "agent_terminated":
        {
          const contextUsage = event.contextUsage ?? this.pendingContextUsage;
          this.writeBlock(
            event.state,
            terminalTone(event.state),
            event.message
          );
          if (contextUsage !== undefined) {
            this.writeBlock("context", "usage", formatContextUsageValue(contextUsage));
          }
          this.pendingContextUsage = undefined;
        }
        return;
      default:
        return;
    }
  }

  private renderAssistantText(delta: string): void {
    if (delta.length === 0) {
      return;
    }
    if (!this.assistantTextOpen) {
      this.writeSeparator();
      this.output.write(`${this.paint("[assistant]", "assistant")}\n`);
      this.hasOutput = true;
      this.assistantTextOpen = true;
    }
    this.output.write(delta);
  }

  private finishAssistantText(): void {
    if (!this.assistantTextOpen) {
      return;
    }
    this.output.write("\n");
    this.assistantTextOpen = false;
    this.hasOutput = true;
  }

  private writeBlock(label: string, tone: Tone, title: string, details: readonly string[] = []): void {
    this.finishAssistantText();
    this.writeSeparator();
    const lines = [`${this.paint(`[${label}]`, tone)}${title.length === 0 ? "" : ` ${title}`}`];
    for (const detail of details) {
      lines.push(indent(detail));
    }
    this.output.write(lines.join("\n") + "\n");
    this.hasOutput = true;
  }

  private writeSeparator(): void {
    if (this.hasOutput) {
      this.output.write("\n");
    }
  }

  private paint(value: string, tone: Tone, color = this.outputColor): string {
    if (!color) {
      return value;
    }
    return `\u001b[${ANSI_COLORS[tone]}m${value}\u001b[0m`;
  }
}
