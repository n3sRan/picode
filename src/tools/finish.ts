import type { ToolDefinition, ToolResult } from "./types.js";
import { createValidator, type JsonSchema } from "./validators.js";

export type FinishStatus = "success" | "partial" | "failure";

export interface FinishArgs {
  status: FinishStatus;
  summary?: string;
  verification?: string;
  remainingIssues?: string;
}

export interface ResolvedFinishArgs {
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
  required: ["status"],
  additionalProperties: false
};

export function normalizeFinishArgs(args: FinishArgs): ResolvedFinishArgs {
  const defaultSummary = args.status === "success"
    ? "Task completed."
    : args.status === "partial"
      ? "Task partially completed."
      : "Task failed.";
  return {
    status: args.status,
    summary: args.summary ?? defaultSummary,
    verification: args.verification ?? "No verification details provided.",
    remainingIssues: args.remainingIssues ?? ""
  };
}

export const finishTool: ToolDefinition<FinishArgs> = {
  name: "finish",
  description: "End the current request. status is required; summary, verification, and remainingIssues are optional.",
  parameters: finishSchema,
  validate: createValidator<FinishArgs>(finishSchema),
  async execute(_context, args): Promise<ToolResult> {
    const normalized = normalizeFinishArgs(args);
    return {
      status: "ok",
      content: JSON.stringify({
        accepted: true,
        status: normalized.status,
        summary: normalized.summary,
        verification: normalized.verification,
        remainingIssues: normalized.remainingIssues
      }),
      metadata: { control: "finish", status: normalized.status }
    };
  }
};
