import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalDirectory } from "../fs-utils.js";

export type AllowedPathRoot = "workspace" | "session_tmp";
export type PathOperation = "read" | "write" | "list" | "search";

export interface PathPolicyOptions {
  workspaceRoot: string;
  sessionId: string;
  tempRoot?: string;
  sessionTmpDir?: string;
}

export interface ResolvedPath {
  inputPath: string;
  absolutePath: string;
  canonicalPath: string;
  root: AllowedPathRoot;
  rootPath: string;
}

// The project contract uses a dedicated directory under the POSIX system
// temporary root. The resolved public path may be /private/tmp on macOS,
// because /tmp itself is a symlink there.
export const DEFAULT_SESSION_TEMP_ROOT = "/tmp";

export type PathPolicyErrorCode =
  | "invalid_path"
  | "not_found"
  | "outside_root"
  | "protected_file"
  | "unresolvable_path"
  | "invalid_workspace"
  | "invalid_session_tmp";

export class PathPolicyError extends Error {
  public readonly name = "PathPolicyError";
  public readonly code: PathPolicyErrorCode;
  public readonly pathValue: string;

  public constructor(code: PathPolicyErrorCode, message: string, pathValue: string) {
    super(message);
    this.code = code;
    this.pathValue = pathValue;
  }
}

function pathIsInside(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === "" || (difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference));
}

function isProtectedSegment(segment: string): boolean {
  return segment === ".env" || (segment.startsWith(".env.") && segment !== ".env.example");
}

function hasProtectedSegment(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  if (difference === "" || difference.startsWith("..") || isAbsolute(difference)) {
    return false;
  }
  return difference.split(sep).some(isProtectedSegment);
}

function pathExists(pathValue: string): boolean {
  try {
    lstatSync(pathValue);
    return true;
  } catch {
    return false;
  }
}

function nearestExistingParent(pathValue: string): { path: string; remaining: string } {
  let current = pathValue;
  const missingSegments: string[] = [];
  while (!pathExists(current)) {
    const parent = dirname(current);
    if (parent === current) {
      throw new PathPolicyError("not_found", `No existing parent for path: ${pathValue}`, pathValue);
    }
    missingSegments.unshift(relative(parent, current));
    current = parent;
  }
  return { path: current, remaining: missingSegments.join(sep) };
}

export class PathPolicy {
  public readonly workspaceRoot: string;
  public readonly sessionTmpDir: string;

  public constructor(options: PathPolicyOptions) {
    try {
      this.workspaceRoot = canonicalDirectory(options.workspaceRoot);
    } catch {
      throw new PathPolicyError("invalid_workspace", `Invalid workspace directory: ${options.workspaceRoot}`, options.workspaceRoot);
    }

    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(options.sessionId)) {
      throw new PathPolicyError("invalid_session_tmp", "Invalid session ID", options.sessionId);
    }

    const requestedSessionDir = options.sessionTmpDir ?? join(options.tempRoot ?? DEFAULT_SESSION_TEMP_ROOT, `picode-${options.sessionId}`);
    try {
      mkdirSync(requestedSessionDir, { recursive: true, mode: 0o700 });
      this.sessionTmpDir = realpathSync(requestedSessionDir);
      if (!statSync(this.sessionTmpDir).isDirectory()) {
        throw new Error("not a directory");
      }
    } catch {
      throw new PathPolicyError("invalid_session_tmp", `Invalid session temp directory: ${requestedSessionDir}`, requestedSessionDir);
    }
  }

  public resolvePath(pathValue: string, operation: PathOperation = "read"): ResolvedPath {
    if (typeof pathValue !== "string" || pathValue.trim().length === 0) {
      throw new PathPolicyError("invalid_path", "Path must be a non-empty string", String(pathValue));
    }

    const absolutePath = isAbsolute(pathValue)
      ? resolve(pathValue)
      : resolve(this.workspaceRoot, pathValue);
    const exists = pathExists(absolutePath);
    let canonicalPath: string;

    if (exists) {
      try {
        canonicalPath = realpathSync(absolutePath);
      } catch {
        throw new PathPolicyError("unresolvable_path", `Unable to resolve path: ${pathValue}`, pathValue);
      }
    } else {
      if (operation !== "write") {
        throw new PathPolicyError("not_found", `Path does not exist: ${pathValue}`, pathValue);
      }
      const parent = nearestExistingParent(absolutePath);
      let canonicalParent: string;
      try {
        canonicalParent = realpathSync(parent.path);
      } catch {
        throw new PathPolicyError("unresolvable_path", `Unable to resolve parent for path: ${pathValue}`, pathValue);
      }
      canonicalPath = parent.remaining.length === 0 ? canonicalParent : join(canonicalParent, parent.remaining);
    }

    const root = this.rootFor(canonicalPath);
    if (root === undefined) {
      throw new PathPolicyError("outside_root", `Path is outside the allowed roots: ${pathValue}`, pathValue);
    }

    const relativeUserSegments = isAbsolute(pathValue) ? [] : pathValue.split(/[\\/]+/);
    if (
      hasProtectedSegment(root.path, canonicalPath) ||
      relativeUserSegments.some(isProtectedSegment)
    ) {
      throw new PathPolicyError("protected_file", `Protected file path is not accessible: ${pathValue}`, pathValue);
    }

    return {
      inputPath: pathValue,
      absolutePath,
      canonicalPath,
      root: root.kind,
      rootPath: root.path
    };
  }

  public resolveExisting(pathValue: string, operation: Exclude<PathOperation, "write"> = "read"): ResolvedPath {
    return this.resolvePath(pathValue, operation);
  }

  public assertWriteTarget(pathValue: string): ResolvedPath {
    return this.resolvePath(pathValue, "write");
  }

  private rootFor(pathValue: string): { kind: AllowedPathRoot; path: string } | undefined {
    if (pathIsInside(this.workspaceRoot, pathValue)) {
      return { kind: "workspace", path: this.workspaceRoot };
    }
    if (pathIsInside(this.sessionTmpDir, pathValue)) {
      return { kind: "session_tmp", path: this.sessionTmpDir };
    }
    return undefined;
  }
}
