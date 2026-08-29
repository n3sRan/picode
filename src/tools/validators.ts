import type { JsonObject } from "../domain/messages.js";
import type { ToolValidator, ValidationIssue, ValidationResult } from "./types.js";

export type JsonSchema = JsonObject & {
  type: "object" | "array" | "string" | "integer" | "number" | "boolean" | "null";
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: readonly unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

export class ToolArgumentValidationError extends Error {
  public readonly name = "ToolArgumentValidationError";
  public readonly issues: readonly ValidationIssue[];

  public constructor(toolName: string, issues: readonly ValidationIssue[]) {
    super(`${toolName} arguments are invalid: ${formatValidationIssues(issues)}`);
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function enumContains(value: unknown, values: readonly unknown[]): boolean {
  return values.some((candidate) => {
    if (Object.is(candidate, value)) {
      return true;
    }
    if (!isRecord(candidate) || !isRecord(value)) {
      return false;
    }
    const candidateKeys = Object.keys(candidate);
    const valueKeys = Object.keys(value);
    return (
      candidateKeys.length === valueKeys.length &&
      candidateKeys.every((key) => enumContains(value[key], [candidate[key]]))
    );
  });
}

function validateValue(value: unknown, schema: JsonSchema, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const expectedType = schema.type;
  const actualType = valueType(value);

  const typeMatches =
    (expectedType === "integer" && typeof value === "number" && Number.isSafeInteger(value)) ||
    (expectedType === "number" && typeof value === "number" && Number.isFinite(value)) ||
    (expectedType === "string" && typeof value === "string") ||
    (expectedType === "boolean" && typeof value === "boolean") ||
    (expectedType === "object" && isRecord(value)) ||
    (expectedType === "array" && Array.isArray(value)) ||
    (expectedType === "null" && value === null);

  if (!typeMatches) {
    issues.push({ path, message: `expected ${expectedType}, received ${actualType}` });
    return issues;
  }

  if (schema.enum !== undefined && !enumContains(value, schema.enum)) {
    issues.push({ path, message: "must be one of the allowed values" });
  }

  if (expectedType === "string") {
    const stringValue = value as string;
    if (schema.minLength !== undefined && stringValue.length < schema.minLength) {
      issues.push({ path, message: `must contain at least ${schema.minLength} characters` });
    }
    if (schema.maxLength !== undefined && stringValue.length > schema.maxLength) {
      issues.push({ path, message: `must contain at most ${schema.maxLength} characters` });
    }
  }

  if (expectedType === "number" || expectedType === "integer") {
    const numberValue = value as number;
    if (schema.minimum !== undefined && numberValue < schema.minimum) {
      issues.push({ path, message: `must be at least ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && numberValue > schema.maximum) {
      issues.push({ path, message: `must be at most ${schema.maximum}` });
    }
  }

  if (expectedType === "array") {
    const arrayValue = value as readonly unknown[];
    if (schema.minItems !== undefined && arrayValue.length < schema.minItems) {
      issues.push({ path, message: `must contain at least ${schema.minItems} items` });
    }
    if (schema.maxItems !== undefined && arrayValue.length > schema.maxItems) {
      issues.push({ path, message: `must contain at most ${schema.maxItems} items` });
    }
    if (schema.items !== undefined) {
      arrayValue.forEach((item, index) => {
        issues.push(...validateValue(item, schema.items as JsonSchema, `${path}[${index}]`));
      });
    }
  }

  if (expectedType === "object") {
    const objectValue = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    for (const requiredKey of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(objectValue, requiredKey)) {
        issues.push({ path: `${path}.${requiredKey}`, message: "is required" });
      }
    }

    for (const [key, childValue] of Object.entries(objectValue)) {
      const childSchema = properties[key];
      if (childSchema === undefined) {
        if (schema.additionalProperties === false) {
          issues.push({ path: `${path}.${key}`, message: "is not allowed" });
        }
        continue;
      }
      issues.push(...validateValue(childValue, childSchema, `${path}.${key}`));
    }
  }

  return issues;
}

export function validateJsonSchema(value: unknown, schema: JsonSchema): ValidationResult<unknown> {
  const issues = validateValue(value, schema, "$" );
  return issues.length === 0 ? { ok: true, value } : { ok: false, issues };
}

export function createValidator<TArgs>(schema: JsonSchema): ToolValidator<TArgs> {
  return (value) => {
    const result = validateJsonSchema(value, schema);
    return result.ok
      ? { ok: true, value: result.value as TArgs }
      : { ok: false, issues: result.issues };
  };
}

export function assertValid<TArgs>(
  toolName: string,
  validator: ToolValidator<TArgs>,
  value: unknown
): TArgs {
  const result = validator(value);
  if (!result.ok) {
    throw new ToolArgumentValidationError(toolName, result.issues);
  }
  return result.value;
}

export function formatValidationIssues(issues: readonly ValidationIssue[]): string {
  return issues.map((issue) => `${issue.path} ${issue.message}`).join("; ");
}
