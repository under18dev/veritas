import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
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
      // Its own process group (POSIX), so a timeout or cancellation can end every process it started.
      detached: process.platform !== 'win32',
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    installExitHook();
    running.add(child);
    const finish = (result: Partial<CommandResult>) => {
      if (settled) return;
      settled = true;
      running.delete(child);
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
      killTree(child);
    }, options.timeoutMs);
    const onAbort = () => killTree(child);
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

/** Children in their own process group do not get the terminal's signals; end them when Veritas exits. */
const running = new Set<ChildProcess>();
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const child of running) killTree(child);
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      for (const child of running) killTree(child);
      process.kill(process.pid, signal);
    });
  }
}

/** Kill a child and everything it started: its process group on POSIX, `taskkill /T` on Windows. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    // already gone
  }
  child.kill('SIGKILL');
}

/** How to start a command found on PATH, without a shell. */
export interface ResolvedCommand {
  command: string;
  /** Arguments to put before the caller's arguments (the script of a Node.js shim). */
  prefix: string[];
}

/**
 * Resolve a bare command name for spawning without a shell. Elsewhere than Windows the name is used as is.
 * On Windows, `.exe`/`.com` files on PATH are used directly; npm and pnpm `.cmd` shims, which cannot be spawned
 * without a shell, are resolved to the Node.js script they wrap and run with this Node.js. Other batch files
 * are not run (their argument quoting is unsafe), and `null` is returned.
 */
export function resolveCommand(
  name: string,
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): ResolvedCommand | null {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32' || /[\\/]/.test(name) || path.extname(name)) return { command: name, prefix: [] };
  const env = options.env ?? process.env;
  const dirs = (env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  for (const dir of dirs) {
    for (const ext of ['.exe', '.com', '.cmd']) {
      const file = path.join(dir, `${name}${ext}`);
      if (!existsSync(file)) continue;
      if (ext !== '.cmd') return { command: file, prefix: [] };
      const script = shimTarget(file);
      return script ? { command: process.execPath, prefix: [script] } : null;
    }
  }
  return null;
}

/** The Node.js script an npm/pnpm `.cmd` shim runs, e.g. `"%~dp0\node_modules\pkg\bin\cli.js" %*`. */
function shimTarget(file: string): string | null {
  const text = readFileSync(file, 'utf8');
  const match = /"%(?:~dp0|dp0%)\\?([^"%]+\.[cm]?js)"\s+%\*/i.exec(text);
  if (!match?.[1]) return null;
  const script = path.resolve(path.dirname(file), ...match[1].split('\\'));
  return existsSync(script) ? script : null;
}
