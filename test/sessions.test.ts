import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AssistantMessage, ToolCall } from "../src/domain/messages.js";
import {
  recoverPendingTool,
  SessionStore,
  SessionStoreError,
  UNKNOWN_PENDING_TOOL_MESSAGE,
  workspaceHash
} from "../src/sessions/index.js";

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

describe("SessionStore", () => {
  it("isolates workspaces, writes atomically, and redacts snapshot contents", () => {
    const workspace = temporaryDirectory("picode-session-workspace-");
    const otherWorkspace = temporaryDirectory("picode-session-other-workspace-");
    const root = temporaryDirectory("picode-session-root-");
    const store = new SessionStore({
      workspaceRoot: workspace,
      rootDir: root,
      redactionSecrets: ["session-secret"]
    });
    const session = store.create("redacted session");
    const updated = {
      ...session,
      updatedAt: "2026-08-30T00:01:00.000Z",
      messages: [{ role: "user" as const, content: "session-secret must not persist" }]
    };
    store.save(updated);

    const projectHash = workspaceHash(store.workspaceRoot);
    const sessionFile = join(root, "projects", projectHash, "sessions", session.id + ".json");
    const contents = readFileSync(sessionFile, "utf8");
    expect(contents).not.toContain("session-secret");
    expect(contents).toContain("[REDACTED]");
    expect(statSync(sessionFile).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(root, "projects", projectHash, "sessions"))).toEqual([
      session.id + ".json"
    ]);
    expect(store.load(session.id.slice(0, 8)).messages[0]).toMatchObject({
      role: "user",
      content: "[REDACTED] must not persist"
    });

    const otherStore = new SessionStore({ workspaceRoot: otherWorkspace, rootDir: root });
    expect(otherStore.list()).toHaveLength(0);
    expect(workspaceHash(store.workspaceRoot)).not.toBe(workspaceHash(otherStore.workspaceRoot));
    expect(
      readdirSync(join(root, "projects", projectHash, "sessions")).some((name) => name.endsWith(".tmp"))
    ).toBe(false);
  });

  it("rejects corrupted snapshots instead of silently discarding them", () => {
    const workspace = temporaryDirectory("picode-session-corrupt-workspace-");
    const root = temporaryDirectory("picode-session-corrupt-root-");
    const store = new SessionStore({ workspaceRoot: workspace, rootDir: root });
    const session = store.create();
    const sessionFile = join(root, "projects", workspaceHash(store.workspaceRoot), "sessions", session.id + ".json");
    writeFileSync(sessionFile, "{not-json", "utf8");

    expect(() => store.load(session.id)).toThrowError(SessionStoreError);
    expect(() => store.list()).toThrowError(SessionStoreError);
  });
});

describe("pending tool recovery", () => {
  it("adds an unknown-result message and never replays the pending tool", () => {
    const toolCall: ToolCall = {
      id: "tool-1",
      name: "write_file",
      rawArguments: "{}",
      arguments: {}
    };
    const assistantMessage: AssistantMessage = {
      role: "assistant",
      content: "",
      toolCalls: [toolCall],
      finishReason: "tool_calls"
    };
    const workspace = temporaryDirectory("picode-recovery-workspace-");
    const root = temporaryDirectory("picode-recovery-root-");
    const store = new SessionStore({ workspaceRoot: workspace, rootDir: root });
    const session = store.create();
    const pendingSession = {
      ...session,
      messages: [assistantMessage],
      pendingTool: {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        startedAt: "2026-08-30T00:00:00.000Z"
      }
    };

    const recovered = recoverPendingTool(pendingSession, new Date("2026-08-30T00:02:00.000Z"));

    expect(recovered.warning).toContain("was not replayed");
    expect(recovered.snapshot.pendingTool).toBeUndefined();
    expect(recovered.snapshot.task).toMatchObject({
      state: "aborted",
      terminalState: "aborted",
      reason: "aborted"
    });
    expect(recovered.snapshot.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "tool-1",
      content: "[aborted] " + UNKNOWN_PENDING_TOOL_MESSAGE
    });
    store.save(recovered.snapshot);
    expect(store.load(session.id).pendingTool).toBeUndefined();
  });

  it("does not duplicate a result that was saved before the pending marker cleanup", () => {
    const workspace = temporaryDirectory("picode-recovery-result-workspace-");
    const root = temporaryDirectory("picode-recovery-result-root-");
    const store = new SessionStore({ workspaceRoot: workspace, rootDir: root });
    const session = store.create();
    const pendingSession = {
      ...session,
      messages: [
        {
          role: "tool" as const,
          toolCallId: "tool-1",
          toolName: "read_file",
          content: "result already saved"
        }
      ],
      pendingTool: {
        toolCallId: "tool-1",
        toolName: "read_file",
        startedAt: "2026-08-30T00:00:00.000Z"
      }
    };

    const recovered = recoverPendingTool(pendingSession);

    expect(recovered.snapshot.messages).toHaveLength(1);
    expect(recovered.snapshot.messages[0]?.content).toBe("result already saved");
    expect(recovered.snapshot.pendingTool).toBeUndefined();
  });

  it("fills every unfinished call in a multi-tool assistant batch", () => {
    const workspace = temporaryDirectory("picode-recovery-batch-workspace-");
    const root = temporaryDirectory("picode-recovery-batch-root-");
    const store = new SessionStore({ workspaceRoot: workspace, rootDir: root });
    const session = store.create();
    const batch = {
      role: "assistant" as const,
      content: "",
      finishReason: "tool_calls" as const,
      toolCalls: [
        { id: "tool-1", name: "read_file", rawArguments: "{}", arguments: {} },
        { id: "tool-2", name: "write_file", rawArguments: "{}", arguments: {} }
      ]
    };
    const pendingSession = {
      ...session,
      messages: [batch],
      pendingTool: {
        toolCallId: "tool-1",
        toolName: "read_file",
        startedAt: "2026-08-30T00:00:00.000Z"
      }
    };

    const recovered = recoverPendingTool(pendingSession);

    expect(recovered.snapshot.messages.filter((message) => message.role === "tool").map(
      (message) => message.toolCallId
    )).toEqual(["tool-1", "tool-2"]);
    expect(store.list()).toHaveLength(1);
  });

  it("repairs a batch gap even when the next pending marker was not written", () => {
    const workspace = temporaryDirectory("picode-recovery-gap-workspace-");
    const root = temporaryDirectory("picode-recovery-gap-root-");
    const store = new SessionStore({ workspaceRoot: workspace, rootDir: root });
    const session = store.create();
    const batch = {
      role: "assistant" as const,
      content: "",
      finishReason: "tool_calls" as const,
      toolCalls: [
        { id: "tool-1", name: "read_file", rawArguments: "{}", arguments: {} },
        { id: "tool-2", name: "write_file", rawArguments: "{}", arguments: {} }
      ]
    };
    const interrupted = {
      ...session,
      messages: [
        batch,
        {
          role: "tool" as const,
          toolCallId: "tool-1",
          toolName: "read_file",
          content: "first result"
        }
      ]
    };

    const recovered = recoverPendingTool(interrupted);

    expect(recovered.warning).toContain("unfinished tool batch");
    expect(recovered.snapshot.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "tool-2"
    });
    expect(recovered.snapshot.pendingTool).toBeUndefined();
  });
});
