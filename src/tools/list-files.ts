import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PathPolicyError } from "../security/path-policy.js";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "./types.js";
import { createValidator, type JsonSchema } from "./validators.js";
import { displayPath, errorResult, successResult } from "./file-utils.js";
import { DEFAULT_TOOL_OUTPUT_LIMIT, summarizeText } from "./output.js";

export interface ListFilesArgs {
  path: string;
  recursive?: boolean;
  maxDepth?: number;
}

const listFilesSchema: JsonSchema = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1 },
    recursive: { type: "boolean" },
    maxDepth: { type: "integer", minimum: 0, maximum: 20 }
  },
  required: ["path"],
  additionalProperties: false
};

interface ListedEntry {
  path: string;
  kind: "file" | "directory" | "symlink" | "other";
}

const MAX_ENTRIES = 2_000;

function addDirectoryEntries(
  context: ToolExecutionContext,
  directoryPath: string,
  rootPath: string,
  recursive: boolean,
  maxDepth: number,
  currentDepth: number,
  entries: ListedEntry[]
): void {
  if (entries.length >= MAX_ENTRIES || (!recursive && currentDepth >= 1) || currentDepth >= maxDepth) {
    return;
  }

  const directoryEntries = readdirSync(directoryPath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const directoryEntry of directoryEntries) {
    if (entries.length >= MAX_ENTRIES) {
      return;
    }

    const candidate = join(directoryPath, directoryEntry.name);
    let resolved;
    try {
      resolved = context.pathPolicy.resolvePath(candidate, "list");
    } catch (error) {
      // A listing can contain an untrusted symlink or a protected entry. It is
      // safer to omit it than to leak its target or stop listing all siblings.
      if (error instanceof PathPolicyError) {
        continue;
      }
      throw error;
    }

    const kind = directoryEntry.isDirectory()
      ? "directory"
      : directoryEntry.isFile()
        ? "file"
        : directoryEntry.isSymbolicLink()
          ? "symlink"
          : "other";
    entries.push({ path: displayPath(candidate, rootPath), kind });

    if (kind === "directory") {
      const stats = statSync(resolved.canonicalPath);
      if (stats.isDirectory()) {
        addDirectoryEntries(
          context,
          resolved.canonicalPath,
          rootPath,
          recursive,
          maxDepth,
          currentDepth + 1,
          entries
        );
      }
    }
  }
}

export const listFilesTool: ToolDefinition<ListFilesArgs> = {
  name: "list_files",
  description: "List files and directories within the workspace or current session temp directory.",
  parameters: listFilesSchema,
  validate: createValidator<ListFilesArgs>(listFilesSchema),
  async execute(context, args): Promise<ToolResult> {
    try {
      const resolved = context.pathPolicy.resolveExisting(args.path, "list");
      if (!statSync(resolved.canonicalPath).isDirectory()) {
        return { status: "error", content: `Path is not a directory: ${args.path}` };
      }

      const entries: ListedEntry[] = [];
      addDirectoryEntries(
        context,
        resolved.canonicalPath,
        resolved.rootPath,
        args.recursive ?? false,
        args.maxDepth ?? 3,
        0,
        entries
      );
      const lines = entries.map((entry) => `${entry.kind}\t${entry.path}`);
      const summary = summarizeText(lines.join("\n"), {
        maxChars: DEFAULT_TOOL_OUTPUT_LIMIT,
        spillDirectory: context.sessionTmpDir,
        artifactPrefix: "list-files",
        redactionSecrets: context.redactionSecrets
      });
      return successResult(summary.content, {
        count: entries.length,
        truncated: summary.truncated,
        ...(summary.artifactPath === undefined ? {} : { artifactPath: summary.artifactPath })
      });
    } catch (error) {
      return errorResult(error);
    }
  }
};
