import { existsSync, mkdirSync, realpathSync, renameSync, statSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

/** Returns the canonical path of an existing directory. */
export function canonicalDirectory(pathValue: string): string {
  if (!statSync(pathValue).isDirectory()) {
    throw new Error("not a directory");
  }
  return realpathSync(pathValue);
}

export function atomicWrite(
  filePath: string,
  writer: (temporaryPath: string) => void,
  options: { ensureParent?: boolean } = {}
): void {
  const directory = dirname(filePath);
  if (options.ensureParent === true) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const temporaryPath = join(directory, `.${basename(filePath)}.${randomUUID()}.tmp`);
  let renamed = false;
  try {
    writer(temporaryPath);
    renameSync(temporaryPath, filePath);
    renamed = true;
  } finally {
    if (!renamed && existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }
  }
}
