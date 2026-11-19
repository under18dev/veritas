import { spawn } from 'node:child_process';
import { redact } from './redact.js';

export interface CommandResult {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** Set when the executable could not be started at all (e.g. ENOENT). */
  spawnError?: string;
}

/** Environment variables passed to child processes by default. Secrets must be opted in explicitly. */
export const DEFAULT_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'CI',
];

export interface RunCommandOptions {
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
  envAllowlist?: string[];
  maxOutputBytes?: number;
  signal?: AbortSignal;
  input?: string;
}

/**
 * Run an executable without a shell (no argument injection), with a timeout, an output cap,
 * an allowlisted environment and redacted output.
 */
export function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  const env: Record<string, string> = {};
  for (const name of options.envAllowlist ?? DEFAULT_ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  Object.assign(env, options.env ?? {});
  const max = options.maxOutputBytes ?? 10 * 1024 * 1024;
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const finish = (result: Partial<CommandResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        command,
        args,
        exitCode: null,
        signal: null,
        stdout: redact(stdout),
        stderr: redact(stderr),
        durationMs: Date.now() - started,
        timedOut,
        ...result,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    const onAbort = () => child.kill('SIGKILL');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < max) stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < max) stderr += d.toString();
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
    child.on('error', (error) => finish({ spawnError: error.message }));
    child.on('close', (exitCode, signal) => finish({ exitCode, signal }));
  });
}
