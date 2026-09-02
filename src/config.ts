import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_MODEL = "gpt-5.6";
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 128_000;
export const DEFAULT_MAX_LLM_REQUESTS = 30;
export const DEFAULT_AUTO_COMPACT = false;
export const DEFAULT_AUTO_COMPACT_THRESHOLD = 0.8;

export const CONFIG_KEYS = [
  "PICODE_API_KEY",
  "PICODE_BASE_URL",
  "PICODE_MODEL",
  "PICODE_CONTEXT_WINDOW",
  "PICODE_MAX_OUTPUT_TOKENS",
  "PICODE_MAX_LLM_REQUESTS",
  "PICODE_AUTO_COMPACT",
  "PICODE_AUTO_COMPACT_THRESHOLD"
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

export interface PicodeConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  maxLlmRequests: number;
  autoCompact: boolean;
  autoCompactThreshold: number;
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  startupDir?: string;
  dotenvPath?: string;
}

export class ConfigError extends Error {
  public readonly name = "ConfigError";

  public constructor(message: string) {
    super(message);
  }
}

export type SupportedConfigValues = Partial<Record<ConfigKey, string>>;

const ALLOWED_CONFIG_KEYS = new Set<string>(CONFIG_KEYS);

function unquoteDotenvValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }

  const first = trimmed[0];
  const last = trimmed.at(-1);
  if ((first !== '"' && first !== "'") || last !== first) {
    return trimmed;
  }

  const inner = trimmed.slice(1, -1);
  return first === '"'
    ? inner.replaceAll("\\\\", "\\").replaceAll('\\"', '"')
    : inner.replaceAll("\\'", "'");
}

function removeInlineComment(value: string): string {
  const commentStart = value.search(/\s#/);
  return commentStart === -1 ? value : value.slice(0, commentStart);
}

function parseDotenvValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    return unquoteDotenvValue(trimmed);
  }
  return removeInlineComment(trimmed).trim();
}

/**
 * Reads only the supported keys. Unknown dotenv entries are discarded
 * and are never copied into process.env or returned to callers.
 */
export function readAllowedDotenv(dotenvPath: string): SupportedConfigValues {
  if (!existsSync(dotenvPath)) {
    return {};
  }

  let contents: string;
  try {
    contents = readFileSync(dotenvPath, "utf8");
  } catch {
    throw new ConfigError(`Unable to read dotenv file: ${dotenvPath}`);
  }

  const values: SupportedConfigValues = {};
  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) {
      throw new ConfigError(`Invalid dotenv syntax at line ${index + 1}`);
    }

    const key = match[1];
    const rawValue = match[2];
    if (key === undefined || rawValue === undefined || !ALLOWED_CONFIG_KEYS.has(key)) {
      continue;
    }

    values[key as ConfigKey] = parseDotenvValue(rawValue);
  }

  return values;
}

function valuesFromProcessEnv(env: NodeJS.ProcessEnv): SupportedConfigValues {
  const values: SupportedConfigValues = {};
  for (const key of CONFIG_KEYS) {
    const value = env[key];
    if (value !== undefined) {
      values[key] = value;
    }
  }
  return values;
}

function requireNonEmpty(values: SupportedConfigValues, key: ConfigKey): string {
  const value = values[key]?.trim();
  if (value === undefined || value.length === 0) {
    throw new ConfigError(`${key} is required`);
  }
  return value;
}

function parseBaseUrl(values: SupportedConfigValues): string {
  const rawValue = values.PICODE_BASE_URL;
  if (rawValue === undefined) {
    return DEFAULT_BASE_URL;
  }

  const value = rawValue.trim();
  if (value.length === 0) {
    throw new ConfigError("PICODE_BASE_URL must be a valid http(s) URL");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError("PICODE_BASE_URL must be a valid http(s) URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError("PICODE_BASE_URL must be a valid http(s) URL");
  }
  return value;
}

function parsePositiveInteger(
  values: SupportedConfigValues,
  key: ConfigKey,
  fallback: number
): number {
  const rawValue = values[key];
  if (rawValue === undefined) {
    return fallback;
  }

  const value = rawValue.trim();
  if (!/^[1-9]\d*$/.test(value)) {
    throw new ConfigError(`${key} must be a positive integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${key} must be a positive integer`);
  }
  return parsed;
}

function parseBoolean(
  values: SupportedConfigValues,
  key: ConfigKey,
  fallback: boolean
): boolean {
  const rawValue = values[key];
  if (rawValue === undefined) {
    return fallback;
  }

  switch (rawValue.trim()) {
    case "true":
      return true;
    case "false":
      return false;
    default:
      throw new ConfigError(`${key} must be true or false`);
  }
}

function parseRatio(
  values: SupportedConfigValues,
  key: ConfigKey,
  fallback: number,
  upperBound: number
): number {
  const rawValue = values[key];
  if (rawValue === undefined) {
    return fallback;
  }

  const parsed = Number(rawValue.trim());
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= upperBound) {
    throw new ConfigError(`${key} must be greater than 0 and less than ${upperBound}`);
  }
  return parsed;
}

function parseModel(values: SupportedConfigValues): string {
  return values.PICODE_MODEL === undefined
    ? DEFAULT_MODEL
    : requireNonEmpty(values, "PICODE_MODEL");
}

export function loadConfig(options: LoadConfigOptions = {}): PicodeConfig {
  const startupDir = options.startupDir ?? process.cwd();
  const dotenvPath = options.dotenvPath ?? resolve(startupDir, ".env");
  const dotenvValues = readAllowedDotenv(dotenvPath);
  const processValues = valuesFromProcessEnv(options.env ?? process.env);
  const values: SupportedConfigValues = { ...dotenvValues, ...processValues };

  return {
    apiKey: requireNonEmpty(values, "PICODE_API_KEY"),
    baseUrl: parseBaseUrl(values),
    model: parseModel(values),
    contextWindow: parsePositiveInteger(values, "PICODE_CONTEXT_WINDOW", DEFAULT_CONTEXT_WINDOW),
    maxOutputTokens: parsePositiveInteger(
      values,
      "PICODE_MAX_OUTPUT_TOKENS",
      DEFAULT_MAX_OUTPUT_TOKENS
    ),
    maxLlmRequests: parsePositiveInteger(
      values,
      "PICODE_MAX_LLM_REQUESTS",
      DEFAULT_MAX_LLM_REQUESTS
    ),
    autoCompact: parseBoolean(values, "PICODE_AUTO_COMPACT", DEFAULT_AUTO_COMPACT),
    autoCompactThreshold: parseRatio(
      values,
      "PICODE_AUTO_COMPACT_THRESHOLD",
      DEFAULT_AUTO_COMPACT_THRESHOLD,
      0.9
    )
  };
}
