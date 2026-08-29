import { statSync } from "node:fs";
import type { ToolDefinition, ToolResult } from "./types.js";
import { createValidator, type JsonSchema } from "./validators.js";
import { displayPath, errorResult, readUtf8Text, successResult } from "./file-utils.js";
import { DEFAULT_TOOL_OUTPUT_LIMIT, summarizeText } from "./output.js";

export interface ReadFileArgs {
  path: string;
  startLine?: number;
  endLine?: number;
}

const readFileSchema: JsonSchema = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1 },
    startLine: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 1 }
  },
  required: ["path"],
  additionalProperties: false
};

export const readFileTool: ToolDefinition<ReadFileArgs> = {
  name: "read_file",
  description: "Read UTF-8 text from an allowed file, optionally selecting a 1-based line range.",
  parameters: readFileSchema,
  validate: createValidator<ReadFileArgs>(readFileSchema),
  async execute(context, args): Promise<ToolResult> {
    try {
      const resolved = context.pathPolicy.resolveExisting(args.path, "read");
      if (!statSync(resolved.canonicalPath).isFile()) {
        return { status: "error", content: `Path is not a regular file: ${args.path}` };
      }
      const text = readUtf8Text(resolved.canonicalPath);
      const lines = text.split(/\r?\n/);
      const startLine = args.startLine ?? 1;
      const endLine = args.endLine ?? lines.length;
      if (startLine > endLine) {
        return { status: "error", content: "startLine must not be greater than endLine" };
      }
      if (startLine > lines.length) {
        return { status: "error", content: `startLine is beyond the end of the file (${lines.length} lines)` };
      }

      const selected = lines
        .slice(startLine - 1, Math.min(endLine, lines.length))
        .map((line, index) => `${startLine + index}: ${line}`)
        .join("\n");
      const summary = summarizeText(selected, {
        maxChars: DEFAULT_TOOL_OUTPUT_LIMIT,
        spillDirectory: context.sessionTmpDir,
        artifactPrefix: "read-file",
        redactionSecrets: context.redactionSecrets
      });
      return successResult(summary.content, {
        path: displayPath(resolved.absolutePath, resolved.rootPath),
        startLine,
        endLine: Math.min(endLine, lines.length),
        truncated: summary.truncated,
        ...(summary.artifactPath === undefined ? {} : { artifactPath: summary.artifactPath })
      });
    } catch (error) {
      return errorResult(error);
    }
  }
};
