import { ExitCode, exitCodeFor, redact, VeritasError } from '@veritas/core';

export interface GlobalOptions {
  json?: boolean;
  root: string;
  allowCodeConfig?: boolean;
}

/** Human-readable logs always go to stderr so `--json` stdout stays pure JSON. */
export function log(message: string): void {
  process.stderr.write(`${redact(message)}\n`);
}

export function emitJson(value: unknown): void {
  process.stdout.write(`${redact(JSON.stringify(value, null, 2))}\n`);
}

export function emitText(text: string): void {
  process.stdout.write(`${redact(text)}\n`);
}

export function reportError(error: unknown, json: boolean | undefined): ExitCode {
  const code = exitCodeFor(error);
  if (json) {
    const body =
      error instanceof VeritasError
        ? {
            status: 'error',
            category: error.category,
            code: error.code,
            message: error.message,
            hint: error.hint ?? null,
          }
        : {
            status: 'error',
            category: 'tool',
            code: 'UNEXPECTED',
            message: (error as Error)?.message ?? String(error),
            hint: null,
          };
    emitJson({ ...body, exitCode: code });
  } else if (error instanceof VeritasError) {
    log(`error[${error.code}]: ${error.message}`);
    if (error.hint) log(`hint: ${error.hint}`);
  } else {
    log(`unexpected error: ${(error as Error)?.stack ?? String(error)}`);
  }
  return code ?? ExitCode.ToolError;
}
