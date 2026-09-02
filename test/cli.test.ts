import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliUsageError, main, parseCliArgs } from "../src/cli.js";

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "picode-cli-phase0-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("CLI argument validation", () => {
  it("canonicalizes an existing --cwd directory and preserves the task", () => {
    const startupDir = createTemporaryDirectory();
    const workspace = join(startupDir, "workspace");
    const nested = join(workspace, "nested");
    mkdirSync(nested, { recursive: true });

    const options = parseCliArgs(["--cwd", "workspace", "fix", "the", "bug"], startupDir);

    expect(options.cwd).toBe(realpathSync(workspace));
    expect(options.task).toBe("fix the bug");
    expect(options.help).toBe(false);
    expect(options.verbose).toBe(false);
  });

  it("accepts --verbose and preserves the task", () => {
    const startupDir = createTemporaryDirectory();

    const options = parseCliArgs(["--verbose", "fix", "the", "bug"], startupDir);

    expect(options.verbose).toBe(true);
    expect(options.task).toBe("fix the bug");
  });

  it("parses explicit resume modes and rejects task combinations", () => {
    const startupDir = createTemporaryDirectory();

    expect(parseCliArgs(["--resume"], startupDir).resume).toBe("");
    const specified = parseCliArgs(["--resume", "abc123", "--verbose"], startupDir);
    expect(specified.resume).toBe("abc123");
    expect(specified.task).toBeUndefined();
    expect(specified.verbose).toBe(true);
    expect(() => parseCliArgs(["--resume", "abc123", "extra"], startupDir)).toThrowError(
      new CliUsageError("--resume cannot be combined with a task")
    );
    expect(() => parseCliArgs(["existing task", "--resume"], startupDir)).toThrowError(
      new CliUsageError("--resume cannot be combined with a task")
    );
    expect(() => parseCliArgs(["--resume", "--resume"], startupDir)).toThrowError(
      new CliUsageError("--resume may be specified only once")
    );
  });

  it("rejects an invalid --cwd explicitly", () => {
    const startupDir = createTemporaryDirectory();
    const missingWorkspace = join(startupDir, "missing");

    expect(() => parseCliArgs(["--cwd", missingWorkspace], startupDir)).toThrowError(
      new CliUsageError(`--cwd must be an existing directory: ${missingWorkspace}`)
    );
  });

  it("returns a failing CLI result for an invalid --cwd before config loading", () => {
    const startupDir = createTemporaryDirectory();
    const stderr: string[] = [];

    const exitCode = main(["--cwd", join(startupDir, "missing")], {
      startupDir,
      env: {},
      stderr: { write: (chunk: string) => stderr.push(chunk) },
      stdout: { write: () => undefined }
    });

    expect(exitCode).toBe(1);
    expect(stderr.join("")).toContain("--cwd must be an existing directory");
  });
});
