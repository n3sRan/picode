import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { redactSecrets } from "../security/redact.js";
import type { ApprovalRequest } from "../security/approval.js";
import type {
  ShellRunRequest,
  ShellRunResult,
  ShellRunner,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult
} from "./types.js";
import { createValidator, type JsonSchema } from "./validators.js";
import { BoundedOutputCollector, DEFAULT_TOOL_OUTPUT_LIMIT } from "./output.js";
import { errorResult, successResult } from "./file-utils.js";

export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

export interface RunCommandArgs {
  command: string;
}

const runCommandSchema: JsonSchema = {
  type: "object",
  properties: {
    command: { type: "string", minLength: 1, maxLength: 100_000 }
  },
  required: ["command"],
  additionalProperties: false
};

export function buildCommandEnvironment(baseEnvironment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnvironment = { ...baseEnvironment };
  for (const key of Object.keys(childEnvironment)) {
    if (key.startsWith("PICODE_")) {
      delete childEnvironment[key];
    }
  }
  // Do not accidentally forward the provider's conventional key either when
  // the parent process happens to have one configured.
  delete childEnvironment.OPENAI_API_KEY;
  return childEnvironment;
}

export function riskNoteForCommand(command: string): string {
  const networkPattern = /(?:^|\s)(?:curl|wget|fetch|nc|netcat|ssh|scp|ftp|npm\s+(?:install|publish)|pnpm\s+(?:install|publish)|yarn\s+(?:add|publish)|git\s+(?:clone|fetch|push)|pip\s+install)(?:\s|$)/i;
  const base = "After approval this command runs with the current user's permissions; it is not sandboxed.";
  return networkPattern.test(command)
    ? `${base} It contains a command commonly associated with network access.`
    : base;
}

function terminateChild(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall back to the child handle when process-group signalling is not
    // available (for example when the shell exits before the timer fires).
  }
  try {
    child.kill(signal);
  } catch {
    // The process may have exited between the two checks.
  }
}

function emptyShellResult(status: "aborted" | "spawn_error", durationMs: number, errorMessage?: string): ShellRunResult {
  return {
    status,
    stdout: "",
    stderr: "",
    exitCode: null,
    signal: null,
    durationMs,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...(errorMessage === undefined ? {} : { errorMessage })
  };
}

export class NodeShellRunner implements ShellRunner {
  public async run(request: ShellRunRequest, signal?: AbortSignal): Promise<ShellRunResult> {
    const startedAt = Date.now();
    if (signal?.aborted) {
      return emptyShellResult("aborted", 0);
    }

    const stdoutCollector = new BoundedOutputCollector({
      maxChars: request.outputLimit,
      spillDirectory: request.spillDirectory,
      artifactPrefix: "command-stdout",
      ...(request.redactionSecrets === undefined ? {} : { redactionSecrets: request.redactionSecrets })
    });
    const stderrCollector = new BoundedOutputCollector({
      maxChars: request.outputLimit,
      spillDirectory: request.spillDirectory,
      artifactPrefix: "command-stderr",
      ...(request.redactionSecrets === undefined ? {} : { redactionSecrets: request.redactionSecrets })
    });

    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(request.command, {
        cwd: request.cwd,
        env: buildCommandEnvironment(request.env),
        shell: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch {
      stdoutCollector.cleanupOnFailure();
      stderrCollector.cleanupOnFailure();
      return emptyShellResult("spawn_error", Date.now() - startedAt, "Unable to start command");
    }

    return await new Promise<ShellRunResult>((resolve) => {
      let settled = false;
      let forcedKillTimer: ReturnType<typeof setTimeout> | undefined;
      let timeoutTriggered = false;
      let abortTriggered = false;
      let spawnError = false;

      const cleanUp = () => {
        clearTimeout(timeoutTimer);
        if (forcedKillTimer !== undefined) {
          clearTimeout(forcedKillTimer);
        }
        signal?.removeEventListener("abort", onAbort);
      };

      const finish = (code: number | null, childSignal: NodeJS.Signals | null) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanUp();
        if (spawnError) {
          stdoutCollector.cleanupOnFailure();
          stderrCollector.cleanupOnFailure();
          resolve(emptyShellResult("spawn_error", Date.now() - startedAt, "Unable to start command"));
          return;
        }

        let stdout;
        let stderr;
        try {
          stdout = stdoutCollector.finish();
          stderr = stderrCollector.finish();
        } catch {
          stdoutCollector.cleanupOnFailure();
          stderrCollector.cleanupOnFailure();
          resolve(emptyShellResult("spawn_error", Date.now() - startedAt, "Unable to collect command output"));
          return;
        }

        const status = abortTriggered ? "aborted" : timeoutTriggered ? "timeout" : "completed";
        resolve({
          status,
          stdout: stdout.text,
          stderr: stderr.text,
          exitCode: code,
          signal: childSignal,
          durationMs: Date.now() - startedAt,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          ...(stdout.artifactPath === undefined ? {} : { stdoutArtifactPath: stdout.artifactPath }),
          ...(stderr.artifactPath === undefined ? {} : { stderrArtifactPath: stderr.artifactPath })
        });
      };

      const onAbort = () => {
        if (settled) {
          return;
        }
        abortTriggered = true;
        terminateChild(child, "SIGTERM");
        forcedKillTimer = setTimeout(() => terminateChild(child, "SIGKILL"), 250);
      };

      const timeoutTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        timeoutTriggered = true;
        terminateChild(child, "SIGTERM");
        forcedKillTimer = setTimeout(() => terminateChild(child, "SIGKILL"), 250);
      }, request.timeoutMs);

      child.stdout.on("data", (chunk: Buffer | string) => stdoutCollector.append(chunk));
      child.stderr.on("data", (chunk: Buffer | string) => stderrCollector.append(chunk));
      child.once("error", () => {
        spawnError = true;
      });
      child.once("close", (code, childSignal) => finish(code, childSignal));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
      }
    });
  }
}

function outputSection(label: string, value: string): string {
  return `${label}:\n${value.length === 0 ? "(empty)" : value}`;
}

function commandResult(result: ShellRunResult): ToolResult {
  if (result.status === "aborted") {
    return {
      status: "aborted",
      content: `${outputSection("stdout", result.stdout)}\n${outputSection("stderr", result.stderr)}\nCommand aborted.`,
      metadata: shellMetadata(result)
    };
  }
  if (result.status === "timeout") {
    return {
      status: "timeout",
      content: `${outputSection("stdout", result.stdout)}\n${outputSection("stderr", result.stderr)}\nCommand timed out.`,
      metadata: shellMetadata(result)
    };
  }
  if (result.status === "spawn_error") {
    return { status: "error", content: result.errorMessage ?? "Unable to start command", metadata: shellMetadata(result) };
  }

  const content = [
    outputSection("stdout", result.stdout),
    outputSection("stderr", result.stderr),
    `exitCode: ${result.exitCode === null ? "null" : result.exitCode}`,
    `signal: ${result.signal ?? "none"}`,
    `durationMs: ${result.durationMs}`,
    result.stdoutTruncated || result.stderrTruncated ? "Output was truncated; see the session artifact path in metadata." : ""
  ].filter((line) => line.length > 0).join("\n");
  return result.exitCode === 0
    ? successResult(content, shellMetadata(result))
    : { status: "error", content, metadata: shellMetadata(result) };
}

function shellMetadata(result: ShellRunResult): Record<string, unknown> {
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    ...(result.stdoutArtifactPath === undefined ? {} : { stdoutArtifactPath: result.stdoutArtifactPath }),
    ...(result.stderrArtifactPath === undefined ? {} : { stderrArtifactPath: result.stderrArtifactPath })
  };
}

function approvalRequest(command: string, context: ToolExecutionContext): ApprovalRequest {
  const safeCommand = redactSecrets(command, context.redactionSecrets ?? []);
  return {
    command: safeCommand,
    cwd: context.workspaceRoot,
    timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    riskNote: riskNoteForCommand(command)
  };
}

export const runCommandTool: ToolDefinition<RunCommandArgs> = {
  name: "run_command",
  description: "Run one shell command from the workspace root after explicit user approval.",
  parameters: runCommandSchema,
  validate: createValidator<RunCommandArgs>(runCommandSchema),
  async execute(context, args, signal): Promise<ToolResult> {
    if (signal.aborted) {
      return { status: "aborted", content: "Command approval was aborted before execution." };
    }

    const request = approvalRequest(args.command, context);
    let approved: boolean;
    try {
      approved = await context.approvalBroker.requestApproval(request, signal);
    } catch (error) {
      return signal.aborted ? { status: "aborted", content: "Command approval was aborted." } : errorResult(error);
    }
    if (signal.aborted) {
      return { status: "aborted", content: "Command approval was aborted." };
    }
    if (!approved) {
      return {
        status: "permission_denied",
        content: "Command was not approved and was not executed.",
        metadata: { approved: false }
      };
    }

    const runner = context.shellRunner ?? new NodeShellRunner();
    const requestEnvironment = buildCommandEnvironment(context.commandEnvironment ?? process.env);
    const shellRequest: ShellRunRequest = {
      command: args.command,
      cwd: context.workspaceRoot,
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
      env: requestEnvironment,
      outputLimit: DEFAULT_TOOL_OUTPUT_LIMIT,
      spillDirectory: context.sessionTmpDir,
      ...(context.redactionSecrets === undefined ? {} : { redactionSecrets: context.redactionSecrets })
    };
    try {
      const result = await runner.run(shellRequest, signal);
      // A fake runner is also an extension boundary; redact it before its
      // output enters the model context or metadata-facing content.
      const safeResult: ShellRunResult = {
        ...result,
        stdout: redactSecrets(result.stdout, context.redactionSecrets ?? []),
        stderr: redactSecrets(result.stderr, context.redactionSecrets ?? [])
      };
      return commandResult(safeResult);
    } catch (error) {
      return signal.aborted ? { status: "aborted", content: "Command was aborted." } : errorResult(error);
    }
  }
};
