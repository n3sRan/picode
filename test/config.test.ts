import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BASE_URL,
  DEFAULT_CONTEXT_WINDOW,
  ConfigError,
  loadConfig,
  readAllowedDotenv
} from "../src/config.js";
import { formatError, REDACTED_VALUE, redactSecrets } from "../src/security/redact.js";

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
        "PICODE_CONTEXT_WINDOW=64000"
      ].join("\n")
    );

    const config = loadConfig({
      startupDir,
      env: {
        PICODE_API_KEY: "process-secret",
        PICODE_BASE_URL: "https://process.example/v1",
        PICODE_MODEL: "process-model",
        PICODE_CONTEXT_WINDOW: "90000"
      }
    });

    expect(config).toEqual({
      apiKey: "process-secret",
      baseUrl: "https://process.example/v1",
      model: "process-model",
      contextWindow: 90000
    });
  });

  it("reads only the four supported keys and applies defaults", () => {
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
      contextWindow: DEFAULT_CONTEXT_WINDOW
    });
  });

  it.each(["PICODE_API_KEY", "PICODE_MODEL"])("fails before a request when %s is missing", (missingKey) => {
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

  it("redacts secrets from error text and output text", () => {
    const secret = "credential-value-that-must-not-leak";
    const source = `request failed: ${secret}`;

    expect(redactSecrets(source, [secret])).toBe(`request failed: ${REDACTED_VALUE}`);
    expect(formatError(new Error(source), [secret])).not.toContain(secret);
  });
});
