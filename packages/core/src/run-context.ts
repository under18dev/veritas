import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { redact, redactDeep } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** One structured log or trace event. Fields are redacted before any sink sees them. */
export interface LogEvent {
  time: string;
  level: LogLevel;
  message: string;
  [field: string]: unknown;
}

export type LogSink = (event: LogEvent) => void;

/**
 * What library code needs to know about the current run without every function taking it as a parameter: the
 * project root (to show paths relative to it), the memory limit for processes started for project code and the
 * solver, and where log and trace events go. Set with `withRunContext`; nested contexts add sinks.
 */
export interface RunContext {
  root?: string;
  memoryMb?: number;
  sinks: LogSink[];
}

const storage = new AsyncLocalStorage<RunContext>();

export function withRunContext<T>(context: Partial<RunContext>, fn: () => T): T {
  const parent = storage.getStore();
  return storage.run(
    {
      root: context.root ?? parent?.root,
      memoryMb: context.memoryMb ?? parent?.memoryMb,
      sinks: [...(parent?.sinks ?? []), ...(context.sinks ?? [])],
    },
    fn,
  );
}

export function runContext(): RunContext | undefined {
  return storage.getStore();
}

/** Send an event to the sinks of the current run context (none outside one). Never throws. */
export function logEvent(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
  const sinks = storage.getStore()?.sinks ?? [];
  if (sinks.length === 0) return;
  const event = {
    ...(redactDeep(fields) as Record<string, unknown>),
    time: new Date().toISOString(),
    level,
    message: redact(message),
  };
  for (const sink of sinks) {
    try {
      sink(event);
    } catch {
      /* a failing sink never breaks a run */
    }
  }
}

/** `file` relative to the run's root when it is inside it, POSIX style; otherwise as given. */
export function relativeToRoot(file: string): string {
  const root = storage.getStore()?.root;
  if (!root) return file;
  const rel = path.relative(root, path.resolve(root, file));
  return rel.startsWith('..') || path.isAbsolute(rel) ? file : rel.split(path.sep).join('/') || '.';
}

/** Node.js flags that cap the V8 heap of a child process at the run's memory limit. */
export function nodeMemoryFlags(memoryMb = storage.getStore()?.memoryMb): string[] {
  return memoryMb ? [`--max-old-space-size=${memoryMb}`] : [];
}

/** Whether a process or worker ended because it ran out of memory. */
export function outOfMemory(stderr: string): boolean {
  return /heap out of memory|Reached heap limit|Allocation failed|ERR_WORKER_OUT_OF_MEMORY|out of memory/i.test(
    stderr,
  );
}

/**
 * Collects trace events as JSON lines up to `maxBytes`; later events are counted, not kept, and the trace says
 * how many were dropped.
 */
export function traceCollector(maxBytes = 4 * 1024 * 1024): { sink: LogSink; text(): string } {
  const lines: string[] = [];
  let bytes = 0;
  let dropped = 0;
  // UTF-8 bytes, with room kept for the closing "truncated" line so the file never exceeds maxBytes.
  const reserve = Math.min(512, Math.floor(maxBytes / 4));
  return {
    sink: (event) => {
      const line = JSON.stringify(event);
      const size = Buffer.byteLength(line, 'utf8') + 1;
      if (dropped > 0 || bytes + size > maxBytes - reserve) {
        dropped++;
        return;
      }
      lines.push(line);
      bytes += size;
    },
    text: () =>
      `${[
        ...lines,
        ...(dropped
          ? [
              JSON.stringify({
                time: new Date().toISOString(),
                level: 'warn',
                message: `trace truncated at ${maxBytes} bytes; ${dropped} later event(s) were dropped`,
              }),
            ]
          : []),
      ].join('\n')}\n`,
  };
}
