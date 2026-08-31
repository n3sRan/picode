export const REDACTED_VALUE = "[REDACTED]";

export function redactSecrets(value: string, secrets: readonly (string | undefined)[]): string {
  const usableSecrets = [...new Set(secrets.filter((secret): secret is string => Boolean(secret)))]
    .sort((left, right) => right.length - left.length);

  return usableSecrets.reduce(
    (redacted, secret) => redacted.split(secret).join(REDACTED_VALUE),
    value
  );
}

export function formatError(error: unknown, secrets: readonly (string | undefined)[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message, secrets);
}

/** Redacts JSON-compatible values while preserving object keys. */
export function redactValue(value: unknown, secrets: readonly (string | undefined)[]): unknown {
  if (typeof value === "string") {
    return redactSecrets(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secrets));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item, secrets)])
    );
  }
  return value;
}
