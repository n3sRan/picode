import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

export interface ApprovalRequest {
  command: string;
  cwd: string;
  timeoutMs: number;
  riskNote: string;
}

export interface ApprovalBroker {
  requestApproval(request: ApprovalRequest, signal?: AbortSignal): Promise<boolean>;
}

export interface CliApprovalBrokerOptions {
  input?: Readable;
  output?: Writable;
  isInteractive?: boolean;
  question?: (prompt: string, signal?: AbortSignal) => Promise<string>;
}

/** Deterministic approval broker for embedding and tests. */
export class ScriptedApprovalBroker implements ApprovalBroker {
  public readonly requests: ApprovalRequest[] = [];
  private readonly decisions: boolean[];
  private readonly defaultDecision: boolean;

  public constructor(decisions: readonly boolean[] = [], defaultDecision = false) {
    this.decisions = [...decisions];
    this.defaultDecision = defaultDecision;
  }

  public async requestApproval(request: ApprovalRequest): Promise<boolean> {
    this.requests.push(request);
    return this.decisions.shift() ?? this.defaultDecision;
  }
}

function isYes(value: string): boolean {
  return ["y", "yes"].includes(value.trim().toLowerCase());
}

export function formatApprovalPrompt(request: ApprovalRequest): string {
  return [
    "",
    "Command approval required",
    `  command: ${request.command}`,
    `  cwd: ${request.cwd}`,
    `  timeout: ${request.timeoutMs}ms`,
    `  risk: ${request.riskNote}`,
    "Allow this command? [y/N] "
  ].join("\n");
}

export class CliApprovalBroker implements ApprovalBroker {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly interactive: boolean;
  private readonly question: CliApprovalBrokerOptions["question"];

  public constructor(options: CliApprovalBrokerOptions = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stderr;
    const inputIsTty = (this.input as Readable & { isTTY?: boolean }).isTTY === true;
    const outputIsTty = (this.output as Writable & { isTTY?: boolean }).isTTY === true;
    this.interactive = options.isInteractive ?? (inputIsTty && outputIsTty);
    this.question = options.question;
  }

  public async requestApproval(request: ApprovalRequest, signal?: AbortSignal): Promise<boolean> {
    if (!this.interactive || signal?.aborted) {
      return false;
    }

    if (this.question !== undefined) {
      try {
        return isYes(await this.question(formatApprovalPrompt(request), signal));
      } catch {
        return false;
      }
    }

    const readline = createInterface({ input: this.input, output: this.output });
    try {
      const answer = await new Promise<string>((resolve, reject) => {
        let settled = false;
        const onAbort = () => {
          if (settled) {
            return;
          }
          settled = true;
          readline.close();
          reject(new Error("Approval cancelled"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        void readline.question(formatApprovalPrompt(request)).then(
          (value) => {
            if (settled) {
              return;
            }
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            resolve(value);
          },
          (error: unknown) => {
            if (settled) {
              return;
            }
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            reject(error);
          }
        );
      });
      return isYes(answer);
    } catch {
      return false;
    } finally {
      readline.close();
    }
  }
}
