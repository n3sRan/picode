export type CliCommand =
  | { kind: "empty" }
  | { kind: "task"; text: string }
  | { kind: "new_session"; name?: string }
  | { kind: "list_sessions" }
  | { kind: "resume_session"; identifier: string }
  | { kind: "compact" }
  | { kind: "exit" };

export class CliCommandError extends Error {
  public readonly name = "CliCommandError";
}

export function parseCliCommand(line: string): CliCommand {
  const input = line.trim();
  if (input.length === 0) {
    return { kind: "empty" };
  }
  if (!input.startsWith("/")) {
    return { kind: "task", text: input };
  }

  const parts = input.split(/\s+/);
  const command = parts[0];
  switch (command) {
    case "/new": {
      const name = parts.slice(1).join(" ").trim();
      return name.length === 0 ? { kind: "new_session" } : { kind: "new_session", name };
    }
    case "/sessions":
      if (parts.length !== 1) {
        throw new CliCommandError("Usage: /sessions");
      }
      return { kind: "list_sessions" };
    case "/resume": {
      if (parts.length !== 2 || parts[1] === undefined || parts[1].length === 0) {
        throw new CliCommandError("Usage: /resume <id>");
      }
      return { kind: "resume_session", identifier: parts[1] };
    }
    case "/compact":
      if (parts.length !== 1) {
        throw new CliCommandError("Usage: /compact");
      }
      return { kind: "compact" };
    case "/exit":
      if (parts.length !== 1) {
        throw new CliCommandError("Usage: /exit");
      }
      return { kind: "exit" };
    default:
      throw new CliCommandError("Unknown command: " + command);
  }
}
