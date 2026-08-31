import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { PathPolicyError } from "../security/path-policy.js";
import { atomicWrite } from "../fs-utils.js";
import type { ToolResult } from "./types.js";
import { MAX_FILE_BYTES } from "./output.js";

export function successResult(content: string, metadata?: Record<string, unknown>): ToolResult {
  return metadata === undefined ? { status: "ok", content } : { status: "ok", content, metadata };
}

export function errorResult(error: unknown): ToolResult {
  if (error instanceof PathPolicyError) {
    const permissionCodes = new Set(["invalid_path", "outside_root", "protected_file", "invalid_workspace", "invalid_session_tmp"]);
    return {
      status: permissionCodes.has(error.code) ? "permission_denied" : "error",
      content: error.message
    };
  }
  return {
    status: "error",
    content: error instanceof Error ? error.message : String(error)
  };
}

export function displayPath(canonicalPath: string, rootPath: string): string {
  const pathValue = relative(rootPath, canonicalPath);
  return pathValue.length === 0 ? "." : pathValue;
}

export function readUtf8Text(pathValue: string): string {
  const stats = statSync(pathValue);
  if (!stats.isFile()) {
    throw new Error(`Path is not a regular file: ${pathValue}`);
  }
  if (stats.size > MAX_FILE_BYTES) {
    throw new Error(`File is too large to read (limit: ${MAX_FILE_BYTES} bytes): ${pathValue}`);
  }
  const buffer = readFileSync(pathValue);
  if (buffer.includes(0)) {
    throw new Error(`Binary files are not supported: ${pathValue}`);
  }
  return buffer.toString("utf8");
}

export function ensureParentDirectory(pathValue: string): void {
  mkdirSync(dirname(pathValue), { recursive: true, mode: 0o700 });
}

/** Writes through a same-directory temporary file and rename. */
export function atomicWriteFile(pathValue: string, contents: string): void {
  atomicWrite(pathValue, (temporaryPath) => {
    writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
  });
}
