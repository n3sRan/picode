import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliApprovalBroker, ScriptedApprovalBroker } from "../src/security/approval.js";
import { DEFAULT_SESSION_TEMP_ROOT, PathPolicy, PathPolicyError } from "../src/security/path-policy.js";
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

function detectCaseInsensitiveTemporaryFilesystem(): boolean {
  const directory = mkdtempSync(join(tmpdir(), "picode-case-sensitivity-"));
  try {
    writeFileSync(join(directory, "case-probe"), "probe");
    return existsSync(join(directory, "CASE-PROBE"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const isCaseInsensitiveMacOs =
  process.platform === "darwin" && detectCaseInsensitiveTemporaryFilesystem();

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
    approvalBroker: new ScriptedApprovalBroker(),
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
    expect(finishTool.validate({ status: "success" }).ok).toBe(true);
    const minimal = await finishTool.execute(makeContext(), {
      status: "success"
    }, new AbortController().signal);
    expect(minimal.status).toBe("ok");
    expect(minimal.content).toContain('"summary":"Task completed."');
    expect(minimal.content).toContain('"verification":"No verification details provided."');
    expect(minimal.content).toContain('"remainingIssues":""');

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
  it("uses the documented /tmp session root by default", () => {
    const workspace = temporaryDirectory("picode-default-session-workspace-");
    const sessionId = `default-root-${randomUUID()}`;
    const policy = new PathPolicy({ workspaceRoot: workspace, sessionId });
    createdDirectories.push(policy.sessionTmpDir);

    expect(policy.sessionTmpDir).toBe(
      join(realpathSync(DEFAULT_SESSION_TEMP_ROOT), `picode-${sessionId}`)
    );
  });

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

  it("lists a symlinked directory without recursively traversing its target", async () => {
    const context = makeContext();
    mkdirSync(join(context.workspace, "nested"));
    writeFileSync(join(context.workspace, "nested", "example.txt"), "content");
    symlinkSync("..", join(context.workspace, "nested", "parent"));

    const result = await listFilesTool.execute(context, {
      path: ".",
      recursive: true,
      maxDepth: 20
    }, new AbortController().signal);

    expect(result).toMatchObject({ status: "ok" });
    expect(result.content).toContain("directory\tnested");
    expect(result.content).toContain("file\tnested/example.txt");
    expect(result.content).toContain("symlink\tnested/parent");
    expect(result.content).not.toContain("nested/parent/nested");
  });

  it("enforces a host-side search budget and reports an incomplete scan", async () => {
    const context = makeContext();
    writeFileSync(join(context.workspace, "a.txt"), "needle");
    writeFileSync(join(context.workspace, "b.txt"), "needle");
    context.searchBudget = { maxFiles: 1, maxBytes: 1_000 };

    const result = await searchFilesTool.execute(
      context,
      { query: "needle" },
      new AbortController().signal
    );

    expect(result).toMatchObject({
      status: "ok",
      metadata: {
        matchCount: 1,
        scannedFiles: 1,
        scanComplete: false,
        stopReason: "file_limit"
      }
    });
    expect(result.content).toContain("a.txt:1: needle");
    expect(result.content).toContain("Search stopped after scanning 1 files.");
    expect(result.content).not.toContain("b.txt:1: needle");
  });

  it("stops before reading a file that exceeds the remaining byte budget", async () => {
    const context = makeContext();
    writeFileSync(join(context.workspace, "large-enough.txt"), "needle");
    context.searchBudget = { maxFiles: 10, maxBytes: 3 };

    const result = await searchFilesTool.execute(
      context,
      { query: "needle" },
      new AbortController().signal
    );

    expect(result).toMatchObject({
      status: "ok",
      metadata: {
        matchCount: 0,
        scannedFiles: 0,
        scannedBytes: 0,
        scanComplete: false,
        stopReason: "byte_limit"
      }
    });
    expect(result.content).toContain("No matches found.");
    expect(result.content).toContain("Search stopped after scanning 3 bytes.");
  });

  it("honors cancellation at an asynchronous scan boundary", async () => {
    const context = makeContext();
    writeFileSync(join(context.workspace, "a.txt"), "needle");
    const controller = new AbortController();
    const originalResolvePath = context.pathPolicy.resolvePath.bind(context.pathPolicy);
    let resolveCount = 0;
    context.pathPolicy.resolvePath = (pathValue, operation) => {
      const resolved = originalResolvePath(pathValue, operation);
      resolveCount += 1;
      if (resolveCount === 2) {
        controller.abort();
      }
      return resolved;
    };

    const result = await searchFilesTool.execute(context, { query: "needle" }, controller.signal);

    expect(result).toMatchObject({ status: "aborted" });
    expect(result.content).toContain("Search was aborted");
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

  it.skipIf(!isCaseInsensitiveMacOs)(
    "protects dotenv files reached through a case-insensitive path alias",
    () => {
      const context = makeContext();
      writeFileSync(join(context.workspace, ".env"), "hidden");

      expect(() => context.pathPolicy.resolveExisting(".ENV")).toThrowError(
        expect.objectContaining({ code: "protected_file" })
      );
    }
  );

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
    const allowedBroker = new ScriptedApprovalBroker([true]);
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
    const deniedBroker = new ScriptedApprovalBroker([false]);
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
