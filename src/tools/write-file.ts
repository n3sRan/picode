import { lstatSync } from "node:fs";
import type { ToolDefinition, ToolResult } from "./types.js";
import { createValidator, type JsonSchema } from "./validators.js";
import { atomicWriteFile, displayPath, ensureParentDirectory, errorResult, successResult } from "./file-utils.js";
import { MAX_FILE_BYTES } from "./output.js";

export interface WriteFileArgs {
  path: string;
  content: string;
}

const writeFileSchema: JsonSchema = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1 },
    content: { type: "string", maxLength: MAX_FILE_BYTES }
  },
  required: ["path", "content"],
  additionalProperties: false
};

export const writeFileTool: ToolDefinition<WriteFileArgs> = {
  name: "write_file",
  description: "Atomically create or overwrite a UTF-8 text file within an allowed root.",
  parameters: writeFileSchema,
  validate: createValidator<WriteFileArgs>(writeFileSchema),
  async execute(context, args): Promise<ToolResult> {
    try {
      const bytes = Buffer.byteLength(args.content, "utf8");
      if (bytes > MAX_FILE_BYTES) {
        return { status: "error", content: `File content exceeds the ${MAX_FILE_BYTES}-byte limit` };
      }
      let resolved = context.pathPolicy.assertWriteTarget(args.path);
      if (lstatSync(resolved.absolutePath, { throwIfNoEntry: false })?.isDirectory()) {
        return { status: "error", content: `Path is a directory: ${args.path}` };
      }

      ensureParentDirectory(resolved.absolutePath);
      // Parent creation can expose a symlink race; resolve the target again
      // immediately before the atomic replacement.
      resolved = context.pathPolicy.assertWriteTarget(args.path);
      if (lstatSync(resolved.absolutePath, { throwIfNoEntry: false })?.isDirectory()) {
        return { status: "error", content: `Path is a directory: ${args.path}` };
      }
      atomicWriteFile(resolved.absolutePath, args.content);
      return successResult(`Wrote ${bytes} bytes to ${displayPath(resolved.absolutePath, resolved.rootPath)}.`, {
        path: displayPath(resolved.absolutePath, resolved.rootPath),
        bytes
      });
    } catch (error) {
      return errorResult(error);
    }
  }
};
