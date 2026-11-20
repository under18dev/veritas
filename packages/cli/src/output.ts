import {
  ExitCode,
  exitCodeFor,
  type LogEvent,
  type LogLevel,
  type LogSink,
  redact,
  VeritasError,
} from '@under18dev/veritas-core';

export interface GlobalOptions {
  json?: boolean;
  root: string;
  allowCodeConfig?: boolean;
  debug?: boolean;
  logFormat?: 'text' | 'json';
}

const logging = { debug: false, format: 'text' as 'text' | 'json' };

/** Set from the global options (`--debug` or VERITAS_DEBUG=1, `--log-format`) before a command runs. */
export function configureLogging(options: { debug?: boolean; format?: 'text' | 'json' }): void {
  logging.debug = Boolean(options.debug) || process.env.VERITAS_DEBUG === '1';
  logging.format = options.format === 'json' ? 'json' : 'text';
}

/**
 * Logs always go to stderr so `--json` stdout stays pure JSON: as text, or with `--log-format json` as one JSON
 * object per line. Debug events (child processes, sandbox calls, stages, cache) appear only with `--debug`.
 */
export const stderrSink: LogSink = (event: LogEvent) => {
  if (event.level === 'debug' && !logging.debug) return;
  if (logging.format === 'json') {
    process.stderr.write(`${redact(JSON.stringify(event))}\n`);
    return;
  }
  const prefix = event.level === 'info' ? '' : `${event.level === 'warn' ? 'warning' : event.level}: `;
  process.stderr.write(`${redact(`${prefix}${event.message}`)}\n`);
};

function emitLog(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
  stderrSink({ ...fields, time: new Date().toISOString(), level, message: redact(message) });
}

export function log(message: string): void {
  emitLog('info', message);
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
  } else if (logging.format === 'json') {
    emitLog('error', (error as Error)?.message ?? String(error), {
      code: error instanceof VeritasError ? error.code : 'UNEXPECTED',
      ...(error instanceof VeritasError && error.hint ? { hint: error.hint } : {}),
      exitCode: code,
    });
  } else if (error instanceof VeritasError) {
    log(`error[${error.code}]: ${error.message}`);
    if (error.hint) log(`hint: ${error.hint}`);
  } else {
    log(`unexpected error: ${(error as Error)?.stack ?? String(error)}`);
  }
  return code ?? ExitCode.ToolError;
}
