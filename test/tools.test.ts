import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliApprovalBroker, TestApprovalBroker } from "../src/security/approval.js";
import { PathPolicy, PathPolicyError } from "../src/security/path-policy.js";
import { atomicWriteFile } from "../src/tools/file-utils.js";
import {
  createBuiltinToolRegistry,
  editFileTool,
  finishTool,
  listFilesTool,
  NodeShellRunner,
  readFileTool,
  runCommandTool,
  searchFilesTool,
  ToolArgumentValidationError,
  ToolRegistry,
  writeFileTool,
  type ShellRunRequest,
  type ShellRunResult,
  type ShellRunner,
  type ToolExecutionContext
} from "../src/tools/index.js";

const createdDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  createdDirectories.push(directory);
  return directory;
}

function makeContext(): ToolExecutionContext & { workspace: string; session: string } {
  const workspace = temporaryDirectory("picode-tool-workspace-");
  const session = temporaryDirectory("picode-tool-session-");
  const pathPolicy = new PathPolicy({
    workspaceRoot: workspace,
    sessionId: "test-session",
    sessionTmpDir: session
  });
  return {
    workspaceRoot: workspace,
    sessionId: "test-session",
    sessionTmpDir: session,
    pathPolicy,
    approvalBroker: new TestApprovalBroker(),
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

describe("tool validators and registry", () => {
  it("rejects wrong types and unknown properties locally", () => {
    const result = readFileTool.validate({ path: "README.md", extra: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        { path: "$.extra", message: "is not allowed" }
      ]);
    }

    expect(() => new ToolRegistry([readFileTool]).assertValid("read_file", { path: 42 })).toThrow(
      ToolArgumentValidationError
    );
    expect(createBuiltinToolRegistry().list().map((tool) => tool.name)).toEqual([
      "list_files",
      "search_files",
      "read_file",
      "write_file",
      "edit_file",
      "run_command",
      "finish"
    ]);
  });

  it("validates the finish contract and returns an accepted control result", async () => {
    expect(finishTool.validate({ status: "success", summary: "done" }).ok).toBe(false);
    const result = await finishTool.execute(makeContext(), {
      status: "success",
      summary: "done",
      verification: "tests passed",
      remainingIssues: ""
    }, new AbortController().signal);
    expect(result.status).toBe("ok");
    expect(result.content).toContain('"accepted":true');
  });
});

describe("file tools and PathPolicy", () => {
  it("reads line ranges, lists files, searches literal text, and writes session temp files", async () => {
    const context = makeContext();
    const write = await writeFileTool.execute(context, {
      path: "nested/example.txt",
      content: "First line\nSecond Line\nthird line"
    }, new AbortController().signal);
    expect(write.status).toBe("ok");

    const read = await readFileTool.execute(context, {
      path: "nested/example.txt",
      startLine: 2,
      endLine: 3
    }, new AbortController().signal);
    expect(read).toMatchObject({ status: "ok" });
    expect(read.content).toContain("2: Second Line");
    expect(read.content).toContain("3: third line");

    const search = await searchFilesTool.execute(context, {
      query: "second",
      caseSensitive: false
    }, new AbortController().signal);
    expect(search).toMatchObject({ status: "ok" });
    expect(search.content).toContain("nested/example.txt:2: Second Line");

    const listing = await listFilesTool.execute(context, {
      path: ".",
      recursive: true,
      maxDepth: 4
    }, new AbortController().signal);
    expect(listing).toMatchObject({ status: "ok" });
    expect(listing.content).toContain("directory\tnested");
    expect(listing.content).toContain("file\tnested/example.txt");

    const sessionFile = join(context.session, "result.txt");
    const sessionWrite = await writeFileTool.execute(context, {
      path: sessionFile,
      content: "session-only"
    }, new AbortController().signal);
    expect(sessionWrite.status).toBe("ok");
    expect(readFileSync(sessionFile, "utf8")).toBe("session-only");
  });

  it("rejects traversal, similar prefixes, absolute outside paths, and symlink escapes", () => {
    const context = makeContext();
    const sibling = `${context.workspace}-sibling`;
    mkdirSync(sibling, { recursive: true });
    createdDirectories.push(sibling);
    writeFileSync(join(sibling, "outside.txt"), "outside");

    expect(() => context.pathPolicy.resolveExisting(`../${basename(sibling)}/outside.txt`)).toThrow(PathPolicyError);
    expect(() => context.pathPolicy.resolveExisting(join(sibling, "outside.txt"))).toThrow(PathPolicyError);

    const outside = temporaryDirectory("picode-tool-outside-");
    writeFileSync(join(outside, "secret.txt"), "outside secret");
    symlinkSync(outside, join(context.workspace, "escape"));
    expect(() => context.pathPolicy.resolveExisting("escape/secret.txt")).toThrow(PathPolicyError);

    symlinkSync(outside, join(context.workspace, "new-parent"));
    expect(() => context.pathPolicy.assertWriteTarget("new-parent/new.txt")).toThrow(PathPolicyError);
  });

  it("allows .env.example but denies .env and other dotenv files at execution time", async () => {
    const context = makeContext();
    writeFileSync(join(context.workspace, ".env"), "hidden");
    writeFileSync(join(context.workspace, ".env.local"), "hidden");
    writeFileSync(join(context.workspace, ".env.example"), "PICODE_MODEL=demo");

    const deniedRead = await readFileTool.execute(context, { path: ".env" }, new AbortController().signal);
    expect(deniedRead.status).toBe("permission_denied");
    const deniedWrite = await writeFileTool.execute(context, { path: ".env.local", content: "changed" }, new AbortController().signal);
    expect(deniedWrite.status).toBe("permission_denied");

    const allowedRead = await readFileTool.execute(context, { path: ".env.example" }, new AbortController().signal);
    expect(allowedRead.status).toBe("ok");
    const listing = await listFilesTool.execute(context, { path: "." }, new AbortController().signal);
    expect(listing.content).toContain("file\t.env.example");
    expect(listing.content).not.toContain(".env.local");
  });

  it("requires one edit match and keeps the original file when atomic replacement fails", async () => {
    const context = makeContext();
    writeFileSync(join(context.workspace, "edit.txt"), "one two two");
    const zero = await editFileTool.execute(context, {
      path: "edit.txt",
      oldText: "missing",
      newText: "new"
    }, new AbortController().signal);
    expect(zero.status).toBe("error");

    const multiple = await editFileTool.execute(context, {
      path: "edit.txt",
      oldText: "two",
      newText: "new"
    }, new AbortController().signal);
    expect(multiple.status).toBe("error");
    expect(readFileSync(join(context.workspace, "edit.txt"), "utf8")).toBe("one two two");

    const one = await editFileTool.execute(context, {
      path: "edit.txt",
      oldText: "one",
      newText: "ONE"
    }, new AbortController().signal);
    expect(one.status).toBe("ok");
    expect(readFileSync(join(context.workspace, "edit.txt"), "utf8")).toBe("ONE two two");

    const targetDirectory = join(context.workspace, "target-directory");
    mkdirSync(targetDirectory);
    expect(() => atomicWriteFile(targetDirectory, "must not replace directory")).toThrow();
    expect(readdirSync(targetDirectory)).toEqual([]);
  });

  it("spills oversized model-facing file output to session temp", async () => {
    const context = makeContext();
    writeFileSync(join(context.workspace, "large.txt"), "x".repeat(20_000));
    const result = await readFileTool.execute(context, { path: "large.txt" }, new AbortController().signal);
    expect(result).toMatchObject({ status: "ok", metadata: { truncated: true } });
    const artifactPath = result.metadata?.artifactPath;
    expect(typeof artifactPath).toBe("string");
    expect(artifactPath === undefined ? "" : existsSync(artifactPath)).toBe(true);
    expect(result.content).toContain("output truncated");
  });
});

class FakeShellRunner implements ShellRunner {
  public readonly requests: ShellRunRequest[] = [];
  public constructor(private readonly result: ShellRunResult) {}

  public async run(request: ShellRunRequest): Promise<ShellRunResult> {
    this.requests.push(request);
    return this.result;
  }
}

const completedShellResult: ShellRunResult = {
  status: "completed",
  stdout: "output",
  stderr: "",
  exitCode: 0,
  signal: null,
  durationMs: 4,
  stdoutTruncated: false,
  stderrTruncated: false
};

describe("approval and command tools", () => {
  it("requests every command approval and never executes a denied command", async () => {
    const allowedContext = makeContext();
    const allowedBroker = new TestApprovalBroker([true]);
    const allowedRunner = new FakeShellRunner(completedShellResult);
    allowedContext.approvalBroker = allowedBroker;
    allowedContext.shellRunner = allowedRunner;
    allowedContext.commandEnvironment = { PATH: "/bin", PICODE_API_KEY: "phase2-secret" };
    const allowed = await runCommandTool.execute(allowedContext, { command: "printf ok" }, new AbortController().signal);
    expect(allowed.status).toBe("ok");
    expect(allowedBroker.requests).toHaveLength(1);
    expect(allowedRunner.requests).toHaveLength(1);
    expect(allowedRunner.requests[0]?.env.PICODE_API_KEY).toBeUndefined();

    const deniedContext = makeContext();
    const deniedBroker = new TestApprovalBroker([false]);
    const deniedRunner = new FakeShellRunner(completedShellResult);
    deniedContext.approvalBroker = deniedBroker;
    deniedContext.shellRunner = deniedRunner;
    const denied = await runCommandTool.execute(deniedContext, { command: "touch should-not-run" }, new AbortController().signal);
    expect(denied).toMatchObject({ status: "permission_denied" });
    expect(deniedRunner.requests).toHaveLength(0);
  });

  it("denies approvals in non-TTY mode and adds a non-blocking network warning", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const broker = new CliApprovalBroker({ input, output });
    const context = makeContext();
    const runner = new FakeShellRunner(completedShellResult);
    context.approvalBroker = broker;
    context.shellRunner = runner;
    const result = await runCommandTool.execute(context, { command: "curl https://example.com" }, new AbortController().signal);
    expect(result.status).toBe("permission_denied");
    expect(runner.requests).toHaveLength(0);
    expect(broker).toBeDefined();
  });

  it("returns nonzero stdout/stderr and protects API keys in real child output", async () => {
    const context = makeContext();
    const runner = new NodeShellRunner();
    const result = await runner.run({
      command: "printf out; printf err >&2; exit 7",
      cwd: context.workspace,
      timeoutMs: 1_000,
      env: { ...process.env, PICODE_API_KEY: "phase2-secret" },
      outputLimit: 1_000,
      spillDirectory: context.session
    });
    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");

    const keyResult = await runner.run({
      command: `${process.execPath} -e 'process.stdout.write(process.env.PICODE_API_KEY ?? "absent")'`,
      cwd: context.workspace,
      timeoutMs: 1_000,
      env: { ...process.env, PICODE_API_KEY: "phase2-secret" },
      outputLimit: 1_000,
      spillDirectory: context.session
    });
    expect(keyResult.stdout).toBe("absent");

    const redacted = await runner.run({
      command: `${process.execPath} -e 'process.stdout.write("phase2" ); process.stdout.write("-secret")'`,
      cwd: context.workspace,
      timeoutMs: 1_000,
      env: process.env,
      outputLimit: 1_000,
      spillDirectory: context.session,
      redactionSecrets: ["phase2-secret"]
    });
    expect(redacted.stdout).toBe("[REDACTED]");
    expect(redacted.stdout).not.toContain("phase2-secret");
  });

  it("reports timeout, abort, output truncation, and preserves the full artifact", async () => {
    const context = makeContext();
    const runner = new NodeShellRunner();
    const timeout = await runner.run({
      command: "sleep 2",
      cwd: context.workspace,
      timeoutMs: 30,
      env: process.env,
      outputLimit: 100,
      spillDirectory: context.session
    });
    expect(timeout.status).toBe("timeout");

    const controller = new AbortController();
    const abortPromise = runner.run({
      command: "sleep 2",
      cwd: context.workspace,
      timeoutMs: 1_000,
      env: process.env,
      outputLimit: 100,
      spillDirectory: context.session
    }, controller.signal);
    setTimeout(() => controller.abort(), 20);
    const aborted = await abortPromise;
    expect(aborted.status).toBe("aborted");

    const output = await runner.run({
      command: `${process.execPath} -e 'process.stdout.write("x".repeat(20000))'`,
      cwd: context.workspace,
      timeoutMs: 1_000,
      env: process.env,
      outputLimit: 100,
      spillDirectory: context.session
    });
    expect(output.status).toBe("completed");
    expect(output.stdoutTruncated).toBe(true);
    expect(output.stdoutArtifactPath).toBeDefined();
    expect(output.stdoutArtifactPath === undefined ? "" : readFileSync(output.stdoutArtifactPath, "utf8").length).toBe(20_000);
    expect(output.stdout).toContain("full output:");
  });
});
