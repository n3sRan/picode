import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_LLM_REQUESTS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_CONTEXT_WINDOW,
  ConfigError,
  loadConfig,
  readAllowedDotenv
} from "../src/config.js";
import { formatError, REDACTED_VALUE, redactSecrets, redactValue } from "../src/security/redact.js";

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "picode-phase0-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadConfig", () => {
  it("gives process environment values precedence over .env values", () => {
    const startupDir = createTemporaryDirectory();
    writeFileSync(
      join(startupDir, ".env"),
      [
        "PICODE_API_KEY=dotenv-secret",
        "PICODE_BASE_URL=https://dotenv.example/v1",
        "PICODE_MODEL=dotenv-model",
        "PICODE_CONTEXT_WINDOW=64000",
        "PICODE_MAX_OUTPUT_TOKENS=8192",
        "PICODE_MAX_LLM_REQUESTS=10"
      ].join("\n")
    );

    const config = loadConfig({
      startupDir,
      env: {
        PICODE_API_KEY: "process-secret",
        PICODE_BASE_URL: "https://process.example/v1",
        PICODE_MODEL: "process-model",
        PICODE_CONTEXT_WINDOW: "90000",
        PICODE_MAX_OUTPUT_TOKENS: "900000",
        PICODE_MAX_LLM_REQUESTS: "20"
      }
    });

    expect(config).toEqual({
      apiKey: "process-secret",
      baseUrl: "https://process.example/v1",
      model: "process-model",
      contextWindow: 90000,
      maxOutputTokens: 900000,
      maxLlmRequests: 20
    });
  });

  it("reads only the six supported keys and applies defaults", () => {
    const startupDir = createTemporaryDirectory();
    const dotenvPath = join(startupDir, ".env");
    writeFileSync(
      dotenvPath,
      [
        "PICODE_API_KEY=dotenv-secret",
        "PICODE_MODEL=dotenv-model",
        "OPENAI_API_KEY=must-not-be-loaded",
        "UNSUPPORTED_SECRET=must-not-be-loaded"
      ].join("\n")
    );

    expect(readAllowedDotenv(dotenvPath)).toEqual({
      PICODE_API_KEY: "dotenv-secret",
      PICODE_MODEL: "dotenv-model"
    });
    expect(
      loadConfig({
        startupDir,
        env: {}
      })
    ).toEqual({
      apiKey: "dotenv-secret",
      baseUrl: DEFAULT_BASE_URL,
      model: "dotenv-model",
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      maxLlmRequests: DEFAULT_MAX_LLM_REQUESTS
    });
  });

  it("uses the configured defaults when optional model and limit values are absent", () => {
    const startupDir = createTemporaryDirectory();

    expect(loadConfig({
      startupDir,
      env: { PICODE_API_KEY: "process-secret" }
    })).toEqual({
      apiKey: "process-secret",
      baseUrl: DEFAULT_BASE_URL,
      model: DEFAULT_MODEL,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      maxLlmRequests: DEFAULT_MAX_LLM_REQUESTS
    });
  });

  it.each(["PICODE_API_KEY"])("fails before a request when %s is missing", (missingKey) => {
    const startupDir = createTemporaryDirectory();
    const env: NodeJS.ProcessEnv = {
      PICODE_API_KEY: "process-secret",
      PICODE_MODEL: "process-model"
    };
    delete env[missingKey];

    expect(() => loadConfig({ startupDir, env })).toThrowError(
      new ConfigError(`${missingKey} is required`)
    );
  });

  it.each([
    "PICODE_CONTEXT_WINDOW",
    "PICODE_MAX_OUTPUT_TOKENS",
    "PICODE_MAX_LLM_REQUESTS"
  ])("rejects a non-positive or non-integer %s", (key) => {
    const startupDir = createTemporaryDirectory();
    const env: NodeJS.ProcessEnv = {
      PICODE_API_KEY: "process-secret",
      [key]: "0.5"
    };

    expect(() => loadConfig({ startupDir, env })).toThrowError(
      new ConfigError(`${key} must be a positive integer`)
    );
  });

  it("rejects an explicitly empty model while allowing it to be omitted", () => {
    const startupDir = createTemporaryDirectory();

    expect(() => loadConfig({
      startupDir,
      env: { PICODE_API_KEY: "process-secret", PICODE_MODEL: "   " }
    })).toThrowError(new ConfigError("PICODE_MODEL is required"));
  });

  it("redacts secrets from error text and output text", () => {
    const secret = "credential-value-that-must-not-leak";
    const source = `request failed: ${secret}`;

    expect(redactSecrets(source, [secret])).toBe(`request failed: ${REDACTED_VALUE}`);
    expect(formatError(new Error(source), [secret])).not.toContain(secret);
  });

  it("redacts JSON values without changing object keys", () => {
    const secret = "credential-value-that-must-not-leak";

    expect(redactValue({ [secret]: secret, nested: { value: secret } }, [secret])).toEqual({
      [secret]: REDACTED_VALUE,
      nested: { value: REDACTED_VALUE }
    });
  });
});
