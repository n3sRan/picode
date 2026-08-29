import type { LlmToolDefinition } from "../llm/provider.js";
import type { JsonObject } from "../domain/messages.js";
import { ToolArgumentValidationError } from "./validators.js";
import type { ToolDefinition, ValidationResult } from "./types.js";

type AnyToolDefinition = ToolDefinition<any>;

export class ToolRegistryError extends Error {
  public readonly name: string = "ToolRegistryError";
}

export class ToolNotFoundError extends ToolRegistryError {
  public readonly name = "ToolNotFoundError";

  public constructor(toolName: string) {
    super(`Unknown tool: ${toolName}`);
  }
}

export class ToolRegistry {
  private readonly definitions = new Map<string, AnyToolDefinition>();

  public constructor(definitions: readonly AnyToolDefinition[] = []) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  public register<TArgs>(definition: ToolDefinition<TArgs>): void {
    if (this.definitions.has(definition.name)) {
      throw new ToolRegistryError(`Tool already registered: ${definition.name}`);
    }
    if (!/^[a-z][a-z0-9_]*$/.test(definition.name)) {
      throw new ToolRegistryError(`Invalid tool name: ${definition.name}`);
    }
    this.definitions.set(definition.name, definition);
  }

  public get(name: string): AnyToolDefinition | undefined {
    return this.definitions.get(name);
  }

  public require(name: string): AnyToolDefinition {
    const definition = this.get(name);
    if (definition === undefined) {
      throw new ToolNotFoundError(name);
    }
    return definition;
  }

  public has(name: string): boolean {
    return this.definitions.has(name);
  }

  public list(): readonly AnyToolDefinition[] {
    return [...this.definitions.values()];
  }

  public validate(name: string, args: unknown): ValidationResult<JsonObject> {
    const definition = this.require(name);
    return definition.validate(args);
  }

  public assertValid(name: string, args: unknown): JsonObject {
    const definition = this.require(name);
    const result = definition.validate(args);
    if (!result.ok) {
      throw new ToolArgumentValidationError(name, result.issues);
    }
    return result.value;
  }

  public toLlmDefinitions(): readonly LlmToolDefinition[] {
    return this.list().map((definition) => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters
    }));
  }
}
