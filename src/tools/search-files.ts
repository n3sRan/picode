import { lstatSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
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
export const DEFAULT_MAX_SEARCH_FILES = 20_000;
export const DEFAULT_MAX_SEARCH_BYTES = 256 * 1024 * 1024;

type SearchStopReason = "match_limit" | "file_limit" | "byte_limit" | "aborted";

interface SearchState {
  matches: string[];
  scannedFiles: number;
  scannedBytes: number;
  maxFiles: number;
  maxBytes: number;
  stopReason?: SearchStopReason;
}

function markStopped(state: SearchState, reason: SearchStopReason): void {
  state.stopReason ??= reason;
}

function stopIfAborted(state: SearchState, signal: AbortSignal): boolean {
  if (!signal.aborted) {
    return false;
  }
  markStopped(state, "aborted");
  return true;
}

function positiveBudget(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

async function searchText(
  filePath: string,
  rootPath: string,
  query: string,
  caseSensitive: boolean,
  state: SearchState,
  signal: AbortSignal
): Promise<void> {
  if (stopIfAborted(state, signal) || state.stopReason !== undefined) {
    return;
  }

  const stats = await stat(filePath);
  if (!stats.isFile() || stats.size > MAX_FILE_BYTES) {
    return;
  }
  if (state.scannedFiles >= state.maxFiles) {
    markStopped(state, "file_limit");
    return;
  }
  if (state.scannedBytes + stats.size > state.maxBytes) {
    markStopped(state, "byte_limit");
    return;
  }

  state.scannedFiles += 1;
  state.scannedBytes += stats.size;

  let content: Buffer;
  try {
    content = await readFile(filePath, { signal });
  } catch (error) {
    if (signal.aborted) {
      markStopped(state, "aborted");
      return;
    }
    throw error;
  }
  if (stopIfAborted(state, signal)) {
    return;
  }

  if (content.includes(0)) {
    return;
  }
  const text = content.toString("utf8");
  const expected = caseSensitive ? query : query.toLocaleLowerCase();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (stopIfAborted(state, signal)) {
      return;
    }
    const comparable = caseSensitive ? line : line.toLocaleLowerCase();
    if (comparable.includes(expected)) {
      state.matches.push(`${relative(rootPath, filePath)}:${index + 1}: ${line}`);
      if (state.matches.length >= MAX_MATCHES) {
        markStopped(state, "match_limit");
        return;
      }
    }
  }
}

async function walkDirectory(
  context: ToolExecutionContext,
  directoryPath: string,
  rootPath: string,
  query: string,
  caseSensitive: boolean,
  state: SearchState,
  signal: AbortSignal
): Promise<void> {
  if (stopIfAborted(state, signal) || state.stopReason !== undefined) {
    return;
  }

  const entries = await readdir(directoryPath);
  if (stopIfAborted(state, signal)) {
    return;
  }
  for (const entry of entries.sort((left, right) => left.localeCompare(right))) {
    if (stopIfAborted(state, signal) || state.stopReason !== undefined) {
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
    const stats = await stat(resolved.canonicalPath);
    if (stopIfAborted(state, signal)) {
      return;
    }
    if (stats.isDirectory()) {
      // Do not follow symlink directories; the policy validates the target,
      // but following them could still create cycles within an allowed root.
      if (!entryWasSymlink(directoryPath, entry)) {
        await walkDirectory(context, resolved.canonicalPath, rootPath, query, caseSensitive, state, signal);
      }
    } else {
      await searchText(resolved.canonicalPath, rootPath, query, caseSensitive, state, signal);
    }
  }
}

function entryWasSymlink(directoryPath: string, entryName: string): boolean {
  return lstatSync(join(directoryPath, entryName)).isSymbolicLink();
}

export const searchFilesTool: ToolDefinition<SearchFilesArgs> = {
  name: "search_files",
  description: "Search literal text in UTF-8 files within the workspace or session temp directory.",
  parameters: searchFilesSchema,
  validate: createValidator<SearchFilesArgs>(searchFilesSchema),
  async execute(context, args, signal): Promise<ToolResult> {
    const state: SearchState = {
      matches: [],
      scannedFiles: 0,
      scannedBytes: 0,
      maxFiles: positiveBudget(context.searchBudget?.maxFiles, DEFAULT_MAX_SEARCH_FILES),
      maxBytes: positiveBudget(context.searchBudget?.maxBytes, DEFAULT_MAX_SEARCH_BYTES)
    };

    if (stopIfAborted(state, signal)) {
      return { status: "aborted", content: "Search was aborted before scanning." };
    }

    try {
      const resolved = args.path === undefined
        ? context.pathPolicy.resolveExisting(context.workspaceRoot, "search")
        : context.pathPolicy.resolveExisting(args.path, "search");
      const stats = await stat(resolved.canonicalPath);
      if (stopIfAborted(state, signal)) {
        return { status: "aborted", content: "Search was aborted before scanning." };
      }
      if (stats.isDirectory()) {
        await walkDirectory(
          context,
          resolved.canonicalPath,
          resolved.rootPath,
          args.query,
          args.caseSensitive ?? false,
          state,
          signal
        );
      } else {
        await searchText(
          resolved.canonicalPath,
          resolved.rootPath,
          args.query,
          args.caseSensitive ?? false,
          state,
          signal
        );
      }

      const summary = summarizeText(state.matches.join("\n"), {
        maxChars: DEFAULT_TOOL_OUTPUT_LIMIT,
        spillDirectory: context.sessionTmpDir,
        artifactPrefix: "search-files",
        redactionSecrets: context.redactionSecrets
      });
      const baseContent = summary.content.length === 0 ? "No matches found." : summary.content;
      const stopMessage = state.stopReason === undefined
        ? undefined
        : state.stopReason === "match_limit"
          ? `Search stopped after reaching the ${MAX_MATCHES}-match limit.`
          : state.stopReason === "file_limit"
            ? `Search stopped after scanning ${state.maxFiles} files.`
            : state.stopReason === "byte_limit"
              ? `Search stopped after scanning ${state.maxBytes} bytes.`
              : "Search was aborted before scanning all files.";
      const content = stopMessage === undefined ? baseContent : `${baseContent}\n${stopMessage}`;
      const metadata = {
        matchCount: state.matches.length,
        scannedFiles: state.scannedFiles,
        scannedBytes: state.scannedBytes,
        scanComplete: state.stopReason === undefined,
        truncated: summary.truncated,
        ...(state.stopReason === undefined ? {} : { stopReason: state.stopReason }),
        ...(summary.artifactPath === undefined ? {} : { artifactPath: summary.artifactPath })
      } satisfies Record<string, unknown>;
      if (state.stopReason === "aborted" || signal.aborted) {
        return { status: "aborted", content, metadata };
      }
      return successResult(content, metadata);
    } catch (error) {
      if (signal.aborted) {
        return { status: "aborted", content: "Search was aborted before scanning all files." };
      }
      return errorResult(error);
    }
  }
};
