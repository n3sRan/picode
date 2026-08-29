import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { PathPolicyError } from "../security/path-policy.js";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "./types.js";
import { createValidator, type JsonSchema } from "./validators.js";
import { errorResult, successResult } from "./file-utils.js";
import { DEFAULT_TOOL_OUTPUT_LIMIT, MAX_FILE_BYTES, summarizeText } from "./output.js";

export interface SearchFilesArgs {
  query: string;
  path?: string;
  caseSensitive?: boolean;
}

const searchFilesSchema: JsonSchema = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1 },
    path: { type: "string", minLength: 1 },
    caseSensitive: { type: "boolean" }
  },
  required: ["query"],
  additionalProperties: false
};

const MAX_MATCHES = 1_000;

function searchText(
  context: ToolExecutionContext,
  filePath: string,
  rootPath: string,
  query: string,
  caseSensitive: boolean,
  matches: string[]
): void {
  if (matches.length >= MAX_MATCHES) {
    return;
  }

  const stats = statSync(filePath);
  if (!stats.isFile() || stats.size > MAX_FILE_BYTES) {
    return;
  }

  const content = readFileSync(filePath);
  if (content.includes(0)) {
    return;
  }
  const text = content.toString("utf8");
  const expected = caseSensitive ? query : query.toLocaleLowerCase();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const comparable = caseSensitive ? line : line.toLocaleLowerCase();
    if (comparable.includes(expected)) {
      matches.push(`${relative(rootPath, filePath)}:${index + 1}: ${line}`);
      if (matches.length >= MAX_MATCHES) {
        return;
      }
    }
  }
}

function walkDirectory(
  context: ToolExecutionContext,
  directoryPath: string,
  rootPath: string,
  query: string,
  caseSensitive: boolean,
  matches: string[]
): void {
  if (matches.length >= MAX_MATCHES) {
    return;
  }
  for (const entry of statSortedEntries(directoryPath)) {
    if (matches.length >= MAX_MATCHES) {
      return;
    }
    const candidate = join(directoryPath, entry);
    let resolved;
    try {
      resolved = context.pathPolicy.resolvePath(candidate, "search");
    } catch (error) {
      if (error instanceof PathPolicyError) {
        continue;
      }
      throw error;
    }
    const stats = statSync(resolved.canonicalPath);
    if (stats.isDirectory()) {
      // Do not follow symlink directories; the policy validates the target,
      // but following them could still create cycles within an allowed root.
      if (!entryWasSymlink(directoryPath, entry)) {
        walkDirectory(context, resolved.canonicalPath, rootPath, query, caseSensitive, matches);
      }
    } else {
      searchText(context, resolved.canonicalPath, rootPath, query, caseSensitive, matches);
    }
  }
}

function statSortedEntries(directoryPath: string): string[] {
  // readdir names are sorted for deterministic model context.
  return readdirSync(directoryPath).sort((left, right) => left.localeCompare(right));
}

function entryWasSymlink(directoryPath: string, entryName: string): boolean {
  return lstatSync(join(directoryPath, entryName)).isSymbolicLink();
}

export const searchFilesTool: ToolDefinition<SearchFilesArgs> = {
  name: "search_files",
  description: "Search literal text in UTF-8 files within the workspace or session temp directory.",
  parameters: searchFilesSchema,
  validate: createValidator<SearchFilesArgs>(searchFilesSchema),
  async execute(context, args): Promise<ToolResult> {
    try {
      const resolved = args.path === undefined
        ? context.pathPolicy.resolveExisting(context.workspaceRoot, "search")
        : context.pathPolicy.resolveExisting(args.path, "search");
      const stats = statSync(resolved.canonicalPath);
      const matches: string[] = [];
      if (stats.isDirectory()) {
        walkDirectory(
          context,
          resolved.canonicalPath,
          resolved.rootPath,
          args.query,
          args.caseSensitive ?? false,
          matches
        );
      } else {
        searchText(
          context,
          resolved.canonicalPath,
          resolved.rootPath,
          args.query,
          args.caseSensitive ?? false,
          matches
        );
      }

      const summary = summarizeText(matches.join("\n"), {
        maxChars: DEFAULT_TOOL_OUTPUT_LIMIT,
        spillDirectory: context.sessionTmpDir,
        artifactPrefix: "search-files",
        redactionSecrets: context.redactionSecrets
      });
      return successResult(summary.content.length === 0 ? "No matches found." : summary.content, {
        matchCount: matches.length,
        truncated: summary.truncated,
        ...(summary.artifactPath === undefined ? {} : { artifactPath: summary.artifactPath })
      });
    } catch (error) {
      return errorResult(error);
    }
  }
};
