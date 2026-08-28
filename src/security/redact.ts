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
