#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { OpenAIChatProvider } from "./llm/openai-chat-provider.js";
import type { LlmProvider } from "./llm/provider.js";
import { loadConfig, readAllowedDotenv } from "./config.js";
import { formatError } from "./security/redact.js";
import { canonicalDirectory as resolveCanonicalDirectory } from "./fs-utils.js";
import { SessionStore } from "./sessions/index.js";
import { exitCodeForTerminalState, TerminalApp } from "./ui/index.js";

export interface CliOptions {
  cwd: string;
  help: boolean;
  task?: string;
}

export interface CliWriter {
  write(chunk: string): unknown;
}

export interface MainOptions {
  env?: NodeJS.ProcessEnv;
  startupDir?: string;
  stdout?: CliWriter;
  stderr?: CliWriter;
  input?: Readable;
  sessionRoot?: string;
  provider?: LlmProvider;
  isInteractive?: boolean;
}

export class CliUsageError extends Error {
  public readonly name = "CliUsageError";

  public constructor(message: string) {
    super(message);
  }
}

const USAGE = `Usage: picode [--cwd <path>] [<task>]

Options:
  --cwd <path>  Use an existing directory as the workspace.
  --help        Show this help.

Interactive commands:
  /new [name]   Create and switch to a new session.
  /sessions     List sessions for the current workspace.
  /resume <id>  Resume a session by full ID or unambiguous prefix.
  /compact      Summarize safe historical context for the current session.
  /exit         Exit interactive mode.
`;

function canonicalCliDirectory(pathValue: string, label: string): string {
  try {
    return resolveCanonicalDirectory(pathValue);
  } catch {
    throw new CliUsageError(`${label} must be an existing directory: ${pathValue}`);
  }
}

export function parseCliArgs(args: readonly string[], startupDir = process.cwd()): CliOptions {
  const canonicalStartupDir = canonicalCliDirectory(startupDir, "startup directory");
  let cwd = canonicalStartupDir;
  let help = false;
  let task: string | undefined;
  let index = 0;

  while (index < args.length) {
    const argument = args[index];
    if (argument === undefined) {
      break;
    }

    if (argument === "--help" || argument === "-h") {
      help = true;
      index += 1;
      continue;
    }

    if (argument === "--cwd") {
      const rawPath = args[index + 1];
      if (rawPath === undefined || rawPath.startsWith("-")) {
        throw new CliUsageError("--cwd requires a path");
      }
      cwd = canonicalCliDirectory(resolve(startupDir, rawPath), "--cwd");
      index += 2;
      continue;
    }

    if (argument.startsWith("--cwd=")) {
      const rawPath = argument.slice("--cwd=".length);
      if (rawPath.length === 0) {
        throw new CliUsageError("--cwd requires a path");
      }
      cwd = canonicalCliDirectory(resolve(startupDir, rawPath), "--cwd");
      index += 1;
      continue;
    }

    if (argument.startsWith("-")) {
      throw new CliUsageError(`unknown option: ${argument}`);
    }

    task = task === undefined ? argument : `${task} ${argument}`;
    index += 1;
  }

  return { cwd, help, ...(task === undefined ? {} : { task }) };
}

function writeCliError(
  error: unknown,
  startupDir: string,
  env: NodeJS.ProcessEnv,
  stderr: CliWriter
): void {
  const dotenvApiKey = (() => {
    try {
      return readAllowedDotenv(resolve(startupDir, ".env")).PICODE_API_KEY;
    } catch {
      return undefined;
    }
  })();
  const message = formatError(error, [env.PICODE_API_KEY, dotenvApiKey]);
  stderr.write("picode: " + message + "\n");
}

async function runConfiguredCli(
  cliOptions: CliOptions,
  config: ReturnType<typeof loadConfig>,
  startupDir: string,
  env: NodeJS.ProcessEnv,
  options: MainOptions
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  try {
    const sessionStore = new SessionStore({
      workspaceRoot: cliOptions.cwd,
      ...(options.sessionRoot === undefined ? {} : { rootDir: options.sessionRoot }),
      redactionSecrets: [config.apiKey]
    });
    const provider = options.provider ?? new OpenAIChatProvider({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      maxOutputTokens: config.maxOutputTokens
    });
    const app = new TerminalApp({
      workspaceRoot: cliOptions.cwd,
      config,
      provider,
      sessionStore,
      input: options.input ?? process.stdin,
      output: stdout as unknown as Writable,
      errorOutput: stderr as unknown as Writable,
      ...(options.isInteractive === undefined ? {} : { isInteractive: options.isInteractive })
    });
    if (cliOptions.task !== undefined) {
      await app.initialize({ newSession: true });
      const result = await app.runTask(cliOptions.task);
      return exitCodeForTerminalState(result.terminalState);
    }
    return await app.runInteractive();
  } catch (error) {
    writeCliError(error, startupDir, env, stderr);
    return 1;
  }
}

export function main(args = process.argv.slice(2), options: MainOptions = {}): number | Promise<number> {
  const startupDir = options.startupDir ?? process.cwd();
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  try {
    const cliOptions = parseCliArgs(args, startupDir);
    if (cliOptions.help) {
      stdout.write(USAGE);
      return 0;
    }

    const config = loadConfig({ startupDir, env });
    return runConfiguredCli(cliOptions, config, startupDir, env, options);
  } catch (error) {
    writeCliError(error, startupDir, env, stderr);
    return 1;
  }
}

const invokedScript = process.argv[1];
if (invokedScript !== undefined) {
  try {
    const invokedPath = realpathSync(resolve(invokedScript));
    const modulePath = realpathSync(fileURLToPath(import.meta.url));
    if (invokedPath === modulePath) {
      const result = main();
      if (typeof result === "number") {
        process.exitCode = result;
      } else {
        void result.then((exitCode) => {
          process.exitCode = exitCode;
        }).catch((error: unknown) => {
          process.stderr.write("picode: " + formatError(error, [process.env.PICODE_API_KEY]) + "\n");
          process.exitCode = 1;
        });
      }
    }
  } catch {
    // Importing this module from tests must not execute the CLI.
  }
}
