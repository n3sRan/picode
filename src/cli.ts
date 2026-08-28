#!/usr/bin/env node

import { realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadConfig, readAllowedDotenv } from "./config.js";
import { formatError } from "./security/redact.js";

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
`;

function canonicalDirectory(pathValue: string, label: string): string {
  try {
    if (!statSync(pathValue).isDirectory()) {
      throw new Error("not a directory");
    }
    return realpathSync(pathValue);
  } catch {
    throw new CliUsageError(`${label} must be an existing directory: ${pathValue}`);
  }
}

export function parseCliArgs(args: readonly string[], startupDir = process.cwd()): CliOptions {
  const canonicalStartupDir = canonicalDirectory(startupDir, "startup directory");
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
      cwd = canonicalDirectory(resolve(startupDir, rawPath), "--cwd");
      index += 2;
      continue;
    }

    if (argument.startsWith("--cwd=")) {
      const rawPath = argument.slice("--cwd=".length);
      if (rawPath.length === 0) {
        throw new CliUsageError("--cwd requires a path");
      }
      cwd = canonicalDirectory(resolve(startupDir, rawPath), "--cwd");
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

export function main(args = process.argv.slice(2), options: MainOptions = {}): number {
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

    // Phase 0 validates configuration before any future network request.
    loadConfig({ startupDir, env });
    stdout.write("picode Phase 0 scaffold is ready; task execution is not implemented yet.\n");
    return 0;
  } catch (error) {
    const dotenvApiKey = (() => {
      try {
        return readAllowedDotenv(resolve(startupDir, ".env")).PICODE_API_KEY;
      } catch {
        return undefined;
      }
    })();
    const message = formatError(error, [env.PICODE_API_KEY, dotenvApiKey]);
    stderr.write(`picode: ${message}\n`);
    return 1;
  }
}

const invokedScript = process.argv[1];
if (invokedScript !== undefined) {
  try {
    const invokedPath = realpathSync(resolve(invokedScript));
    const modulePath = realpathSync(fileURLToPath(import.meta.url));
    if (invokedPath === modulePath) {
      process.exitCode = main();
    }
  } catch {
    // Importing this module from tests must not execute the CLI.
  }
}
