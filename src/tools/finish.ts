import type { ToolDefinition, ToolResult } from "./types.js";
import { createValidator, type JsonSchema } from "./validators.js";

export type FinishStatus = "success" | "partial" | "failure";

export interface FinishArgs {
  status: FinishStatus;
  summary: string;
  verification: string;
  remainingIssues: string;
}

const finishSchema: JsonSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["success", "partial", "failure"] },
    summary: { type: "string", minLength: 1 },
    verification: { type: "string", minLength: 1 },
    remainingIssues: { type: "string" }
  },
  required: ["status", "summary", "verification", "remainingIssues"],
  additionalProperties: false
};

export const finishTool: ToolDefinition<FinishArgs> = {
  name: "finish",
  description: "Explicitly report task completion, partial completion, or failure with verification details.",
  parameters: finishSchema,
  validate: createValidator<FinishArgs>(finishSchema),
  async execute(_context, args): Promise<ToolResult> {
    return {
      status: "ok",
      content: JSON.stringify({
        accepted: true,
        status: args.status,
        summary: args.summary,
        verification: args.verification,
        remainingIssues: args.remainingIssues
      }),
      metadata: { control: "finish", status: args.status }
    };
  }
};
