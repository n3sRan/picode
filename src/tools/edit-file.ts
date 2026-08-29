import { statSync } from "node:fs";
import type { ToolDefinition, ToolResult } from "./types.js";
import { createValidator, type JsonSchema } from "./validators.js";
import { atomicWriteFile, displayPath, errorResult, readUtf8Text, successResult } from "./file-utils.js";
import { MAX_FILE_BYTES } from "./output.js";

export interface EditFileArgs {
  path: string;
  oldText: string;
  newText: string;
}

const editFileSchema: JsonSchema = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1 },
    oldText: { type: "string", minLength: 1, maxLength: MAX_FILE_BYTES },
    newText: { type: "string", maxLength: MAX_FILE_BYTES }
  },
  required: ["path", "oldText", "newText"],
  additionalProperties: false
};

function countNonOverlapping(text: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const match = text.indexOf(needle, offset);
    if (match === -1) {
      return count;
    }
    count += 1;
    offset = match + needle.length;
  }
}

export const editFileTool: ToolDefinition<EditFileArgs> = {
  name: "edit_file",
  description: "Replace exactly one occurrence in a UTF-8 file using an atomic same-directory write.",
  parameters: editFileSchema,
  validate: createValidator<EditFileArgs>(editFileSchema),
  async execute(context, args): Promise<ToolResult> {
    try {
      const resolved = context.pathPolicy.resolveExisting(args.path, "read");
      if (!statSync(resolved.canonicalPath).isFile()) {
        return { status: "error", content: `Path is not a regular file: ${args.path}` };
      }
      const original = readUtf8Text(resolved.canonicalPath);
      const matchCount = countNonOverlapping(original, args.oldText);
      if (matchCount === 0) {
        return { status: "error", content: "oldText was not found exactly once (found 0 matches)" };
      }
      if (matchCount > 1) {
        return { status: "error", content: `oldText was not found exactly once (found ${matchCount} matches)` };
      }

      const updated = original.replace(args.oldText, args.newText);
      if (Buffer.byteLength(updated, "utf8") > MAX_FILE_BYTES) {
        return { status: "error", content: `Edited file exceeds the ${MAX_FILE_BYTES}-byte limit` };
      }

      const writeTarget = context.pathPolicy.assertWriteTarget(args.path);
      if (statSync(writeTarget.canonicalPath).isDirectory()) {
        return { status: "error", content: `Path is a directory: ${args.path}` };
      }
      atomicWriteFile(writeTarget.absolutePath, updated);
      return successResult(`Edited ${displayPath(writeTarget.absolutePath, writeTarget.rootPath)} (1 replacement).`, {
        path: displayPath(writeTarget.absolutePath, writeTarget.rootPath),
        replacements: 1,
        bytes: Buffer.byteLength(updated, "utf8")
      });
    } catch (error) {
      return errorResult(error);
    }
  }
};
