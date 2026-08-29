import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { redactSecrets } from "../security/redact.js";

export const DEFAULT_TOOL_OUTPUT_LIMIT = 12_000;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface TextSummaryOptions {
  maxChars?: number;
  spillDirectory: string;
  artifactPrefix: string;
  redactionSecrets?: readonly (string | undefined)[] | undefined;
}

export interface TextSummary {
  content: string;
  truncated: boolean;
  characterCount: number;
  byteCount: number;
  artifactPath?: string;
}

function createArtifactPath(directory: string, prefix: string): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return join(directory, `.picode-${prefix}-${randomUUID()}.txt`);
}

export function summarizeText(text: string, options: TextSummaryOptions): TextSummary {
  const redactedText = redactSecrets(text, options.redactionSecrets ?? []);
  const maxChars = options.maxChars ?? DEFAULT_TOOL_OUTPUT_LIMIT;
  const characterCount = redactedText.length;
  const byteCount = Buffer.byteLength(redactedText, "utf8");

  if (characterCount <= maxChars) {
    return { content: redactedText, truncated: false, characterCount, byteCount };
  }

  let artifactPath: string | undefined;
  try {
    artifactPath = createArtifactPath(options.spillDirectory, options.artifactPrefix);
    // The text is redacted before it is persisted, so the artifact cannot leak
    // a configured API key through a large output path.
    writeFileSync(artifactPath, redactedText, { encoding: "utf8", mode: 0o600 });
  } catch {
    artifactPath = undefined;
  }

  const suffix = artifactPath === undefined
    ? `\n[output truncated at ${maxChars} characters]`
    : `\n[output truncated at ${maxChars} characters; full output: ${artifactPath}]`;
  return {
    content: `${redactedText.slice(0, maxChars)}${suffix}`,
    truncated: true,
    characterCount,
    byteCount,
    ...(artifactPath === undefined ? {} : { artifactPath })
  };
}

interface StreamingRedactor {
  push(chunk: string): string;
  finish(): string;
}

function createStreamingRedactor(secrets: readonly (string | undefined)[]): StreamingRedactor {
  const usableSecrets = [...new Set(secrets.filter((secret): secret is string => Boolean(secret)))];
  // Keep a full maximum-length suffix. This also retains a secret whose first
  // character is just before the chunk boundary; retaining maxLength - 1
  // would emit that first character before the remaining chunk arrived.
  const overlap = Math.max(0, ...usableSecrets.map((secret) => secret.length));
  let carry = "";

  return {
    push(chunk: string): string {
      if (usableSecrets.length === 0) {
        return chunk;
      }
      const combined = `${carry}${chunk}`;
      const emitLength = Math.max(0, combined.length - overlap);
      const safe = combined.slice(0, emitLength);
      carry = combined.slice(emitLength);
      return redactSecrets(safe, usableSecrets);
    },
    finish(): string {
      const result = redactSecrets(carry, usableSecrets);
      carry = "";
      return result;
    }
  };
}

export interface BoundedOutputResult {
  text: string;
  truncated: boolean;
  totalBytes: number;
  artifactPath?: string;
}

/**
 * Captures only a bounded amount in memory. Once the limit is exceeded, the
 * complete redacted stream is written to a session artifact and only its tail
 * is read back for the model-facing summary.
 */
export class BoundedOutputCollector {
  private readonly maxBytes: number;
  private readonly spillDirectory: string;
  private readonly artifactPrefix: string;
  private readonly redactor: StreamingRedactor;
  private chunks: Buffer[] = [];
  private totalBytes = 0;
  private fileDescriptor: number | undefined;
  private artifactPath: string | undefined;

  public constructor(options: {
    maxChars: number;
    spillDirectory: string;
    artifactPrefix: string;
    redactionSecrets?: readonly (string | undefined)[];
  }) {
    this.maxBytes = options.maxChars;
    this.spillDirectory = options.spillDirectory;
    this.artifactPrefix = options.artifactPrefix;
    this.redactor = createStreamingRedactor(options.redactionSecrets ?? []);
  }

  public append(chunk: Buffer | string): void {
    const redacted = this.redactor.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    this.appendRedacted(redacted);
  }

  private appendRedacted(redacted: string): void {
    if (redacted.length === 0) {
      return;
    }
    const bytes = Buffer.from(redacted, "utf8");
    this.totalBytes += bytes.byteLength;

    if (this.fileDescriptor === undefined && this.totalBytes <= this.maxBytes) {
      this.chunks.push(bytes);
      return;
    }

    if (this.fileDescriptor === undefined) {
      mkdirSync(this.spillDirectory, { recursive: true, mode: 0o700 });
      this.artifactPath = createArtifactPath(this.spillDirectory, this.artifactPrefix);
      this.fileDescriptor = openSync(this.artifactPath, "w", 0o600);
      for (const previous of this.chunks) {
        writeSync(this.fileDescriptor, previous);
      }
      this.chunks = [];
    }
    writeSync(this.fileDescriptor, bytes);
  }

  public finish(): BoundedOutputResult {
    const finalChunk = this.redactor.finish();
    if (finalChunk.length > 0) {
      this.appendRedacted(finalChunk);
    }

    if (this.fileDescriptor === undefined) {
      return {
        text: Buffer.concat(this.chunks).toString("utf8"),
        truncated: false,
        totalBytes: this.totalBytes
      };
    }

    closeSync(this.fileDescriptor);
    this.fileDescriptor = undefined;

    const artifactPath = this.artifactPath;
    if (artifactPath === undefined) {
      return { text: "", truncated: true, totalBytes: this.totalBytes };
    }

    const fileSize = statSync(artifactPath).size;
    const tailLength = Math.min(this.maxBytes, fileSize);
    const descriptor = openSync(artifactPath, "r");
    const tail = Buffer.alloc(tailLength);
    try {
      readSync(descriptor, tail, 0, tailLength, fileSize - tailLength);
    } finally {
      closeSync(descriptor);
    }
    const suffix = `\n[output truncated; full output: ${artifactPath}]`;
    return {
      text: `${tail.toString("utf8")}${suffix}`,
      truncated: true,
      totalBytes: this.totalBytes,
      artifactPath
    };
  }

  public cleanupOnFailure(): void {
    if (this.fileDescriptor !== undefined) {
      closeSync(this.fileDescriptor);
      this.fileDescriptor = undefined;
    }
    if (this.artifactPath !== undefined && existsSync(this.artifactPath)) {
      unlinkSync(this.artifactPath);
    }
  }
}
