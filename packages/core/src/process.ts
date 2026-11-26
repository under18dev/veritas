import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createRedactor, REDACTED, redact, redactArgs } from './redact.js';
import { logEvent, nodeMemoryFlags, outOfMemory, relativeToRoot } from './run-context.js';

export interface CommandResult {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /**
   * The last characters of stderr (at most STDERR_TAIL_CHARS) written after `stderr` reached `maxOutputBytes`. Set
   * only then: `stderr` keeps the head of the output, and this keeps how it ended, where summaries are printed.
   */
  stderrTail?: string;
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
  /** Also send each output line as a debug event while the process runs, for long runs someone is watching. */
  logOutput?: boolean;
  /** The name log events give the process (default: the executable's name), e.g. `mutator` for `node cli.js`. */
  label?: string;
  /**
   * Every piece of output as it arrives, decoded, before any cap: for a caller that must see all of it, such as a
   * marker that may come after `maxOutputBytes`. A line may be split between two calls.
   */
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void;
}

/** Characters of stderr kept from its end once the head buffer is full. */
export const STDERR_TAIL_CHARS = 64 * 1024;
/** Output lines sent as events per process, so a chatty process cannot flood a trace. */
const OUTPUT_EVENT_LIMIT = 2000;
/** Characters of an output line shown in its event. */
const OUTPUT_LINE_CHARS = 300;
/** Characters of an output line kept and redacted before it is cut to OUTPUT_LINE_CHARS; the rest is not buffered.
 * Redacting more than is shown means a secret that crosses the cut is matched whole, not shown in part. */
const OUTPUT_HEAD_CHARS = OUTPUT_LINE_CHARS + 1024;
/** Characters of the previous line redacted together with a line, for secrets split by a newline
 * (`password:` then the value on the next line, `Authorization: Bearer` then the token). */
const OUTPUT_CONTEXT_CHARS = 200;
/** Terminal escape sequences (CSI, OSC ended by BEL or ST or by the end of the text, other escapes with their
 * intermediate bytes) and control characters other than tab. */
const TERMINAL_CONTROL =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences and control characters are removed
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\|$)|[ -/]*[0-~])|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
/** The start or end of a PEM private key, as redact() matches whole blocks. */
const KEY_MARKER = /-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----/g;
/** Characters kept from the end of a chunk, so a marker split between chunks is still found. */
const KEY_MARKER_CARRY = 80;

type OutputStream = 'stdout' | 'stderr';

interface OutputLine {
  /** The first OUTPUT_HEAD_CHARS + 1 characters of the line so far (after its last carriage return). */
  head: string;
  /** The last OUTPUT_CONTEXT_CHARS characters of the line so far (after its last carriage return). */
  tail: string;
  /** Whether the text so far ended with a carriage return: a progress redraw replaces the line unless `\n` follows. */
  cr: boolean;
  carry: string;
  /** Whether the line has the start of a key block, and the last marker it has. */
  begin: boolean;
  last: 'BEGIN' | 'END' | null;
  /** Whether the line is inside a key block that an earlier line started. */
  inKey: boolean;
}

const emptyLine = (): OutputLine => ({
  head: '',
  tail: '',
  cr: false,
  carry: '',
  begin: false,
  last: null,
  inKey: false,
});

/** Output text with terminal escape sequences and control characters (other than tab) removed. */
export function stripTerminalControl(text: string): string {
  return text.replace(TERMINAL_CONTROL, '');
}

/**
 * A line of process output made safe to show: escapes removed, secrets redacted together with the end of the
 * previous line (`context`), then cut to `limit` characters without leaving part of a word (a token) at the cut.
 * `more` says the line went on past `head`, so its last word may be cut short and is dropped before redacting.
 * Returns an empty string for a blank line.
 */
export function safeOutputLine(
  head: string,
  options: { context?: string; more?: boolean; limit?: number; redactor?: (text: string) => string } = {},
): string {
  const limit = options.limit ?? OUTPUT_LINE_CHARS;
  const redactText = options.redactor ?? redact;
  let text = stripTerminalControl(head);

  if (options.more) text = text.replace(/\S+$/, '');
  const context = stripTerminalControl(options.context ?? '');
  let line = text;

  if (context.trim()) {
    const combined = redactText(`${context}\n${text}`);
    const newline = combined.indexOf('\n');
    // Neither the context nor the line has a newline and a redaction marker has none, so a surviving newline is the
    // boundary. If a redaction took it, the line's part of that match is replaced too: only the end of the line that
    // the redacted text still has (a common suffix) is kept.
    if (newline >= 0) line = combined.slice(newline + 1);
    else {
      let same = 0;

      while (same < text.length && same < combined.length && text.at(-1 - same) === combined.at(-1 - same))
        same++;
      line = `${REDACTED}${combined.slice(combined.length - same)}`;
    }
  } else line = redactText(text);
  line = line.trim();
  let cut = options.more ?? false;

  if (line.length > limit) {
    // A word running over the limit is dropped whole, so no part of a token is shown.
    line = /\s/.test(line[limit] ?? ' ') ? line.slice(0, limit) : line.slice(0, limit).replace(/\S+$/, '');
    line = line.trimEnd();
    cut = true;
  }

  return cut ? `${line}...` : line;
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
  const name = options.label ?? path.basename(command);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let stderrTail: string | null = null;
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
    // So a long-running process shows up while it runs, not only once it ends.
    logEvent('debug', `${name} started`, {
      event: 'process-start',
      command: path.basename(command),
      cwd: relativeToRoot(options.cwd),
    });
    // Output lines are kept to OUTPUT_HEAD_CHARS and scanned for private key blocks as they arrive, so memory stays
    // bounded and a key spread over lines (which redact() only catches whole) never reaches an event.
    const lines = { stdout: emptyLine(), stderr: emptyLine() };
    // The end of the previous line of each stream, redacted with the next line.
    const previous = { stdout: '', stderr: '' };
    const redactor = options.logOutput ? createRedactor() : redact;
    let outputEvents = 0;
    const emit = (stream: OutputStream, line: string) => {
      if (!line || ++outputEvents > OUTPUT_EVENT_LIMIT) return;
      logEvent('debug', `${name}: ${line}`, {
        event: 'process-output',
        command: path.basename(command),
        stream,
      });
    };
    const endLine = (stream: OutputStream) => {
      const line = lines[stream];
      const inKey = line.inKey;
      lines[stream] = { ...emptyLine(), inKey: line.last === null ? inKey : line.last === 'BEGIN' };

      // The body and the end of a key block are dropped; the line that starts one is reported as redacted.
      if (inKey || line.begin) {
        previous[stream] = '';

        if (!inKey) emit(stream, REDACTED);

        return;
      }
      const text = safeOutputLine(line.head.slice(0, OUTPUT_HEAD_CHARS), {
        context: previous[stream],
        more: line.head.length > OUTPUT_HEAD_CHARS,
        redactor,
      });

      // A blank line keeps the previous context, so a value after an empty line is still redacted.
      if (text) previous[stream] = line.tail;
      emit(stream, text);
    };
    const addText = (line: OutputLine, segment: string) => {
      const trailing = /\r+$/.exec(segment);
      let text = trailing ? segment.slice(0, trailing.index) : segment;

      // A carriage return not followed by a newline (a progress redraw) replaces what the line had.
      if (text && line.cr) {
        line.head = '';
        line.tail = '';
      }

      if (text) line.cr = false;
      const at = text.lastIndexOf('\r');

      if (at >= 0) {
        line.head = '';
        line.tail = '';
        text = text.slice(at + 1);
      }

      if (trailing) line.cr = true;

      if (line.head.length <= OUTPUT_HEAD_CHARS)
        line.head += text.slice(0, OUTPUT_HEAD_CHARS + 1 - line.head.length);
      line.tail = (line.tail + text.slice(-OUTPUT_CONTEXT_CHARS)).slice(-OUTPUT_CONTEXT_CHARS);
    };
    const logLines = (stream: OutputStream, text: string) => {
      if (!options.logOutput || outputEvents >= OUTPUT_EVENT_LIMIT) return;
      const segments = text.split('\n');

      for (const [index, segment] of segments.entries()) {
        const line = lines[stream];
        addText(line, segment);
        // The end of the previous segment is scanned again, for a marker split between two chunks.
        const window = line.carry + segment;

        for (const match of window.matchAll(KEY_MARKER)) {
          if (match[1] === 'BEGIN') line.begin = true;
          line.last = match[1] as 'BEGIN' | 'END';
        }
        line.carry = window.slice(-KEY_MARKER_CARRY);

        if (index < segments.length - 1) endLine(stream);
      }
    };
    // Per stream, so a multi-byte UTF-8 character split between two chunks is decoded whole.
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const onData = (stream: OutputStream, text: string) => {
      if (!text) return;
      options.onOutput?.(stream, text);

      if (stream === 'stdout') {
        if (stdout.length < max) stdout += text;
      } else if (stderr.length < max) stderr += text;
      else stderrTail = `${stderrTail ?? ''}${text}`.slice(-STDERR_TAIL_CHARS);
      logLines(stream, text);
    };
    const finish = (result: Partial<CommandResult>) => {
      if (settled) return;
      settled = true;
      running.delete(child);
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);

      // The last line of output may have no newline.
      for (const stream of ['stdout', 'stderr'] as const) {
        onData(stream, decoders[stream].end());

        if (lines[stream].head || lines[stream].begin) endLine(stream);
      }
      // Debug trace: what ran, where and how it ended. Arguments are capped and redacted; never the environment
      // or the input/output contents.
      const durationMs = Date.now() - started;
      logEvent(
        'debug',
        `${name} ${result.spawnError ? 'could not start' : `exited ${result.exitCode ?? result.signal}`}${timedOut ? ' (timed out and killed)' : ''} after ${durationMs} ms`,
        {
          event: 'process',
          command: path.basename(command),
          args: redactArgs(args.slice(0, 40)).map((a) => (a.length > 300 ? `${a.slice(0, 300)}...` : a)),
          cwd: relativeToRoot(options.cwd),
          durationMs,
          exitCode: result.exitCode ?? null,
          signal: result.signal ?? null,
          timedOut,
          aborted: options.signal?.aborted ?? false,
          ...(result.spawnError ? { spawnError: result.spawnError } : {}),
          ...(outOfMemory(stderr) ? { outOfMemory: true } : {}),
        },
      );
      resolve({
        command,
        args,
        exitCode: null,
        signal: null,
        stdout: redact(stdout),
        stderr: redact(stderr),
        ...(stderrTail === null ? {} : { stderrTail: redact(stderrTail) }),
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
    // A signal that was aborted before (or while) the process started never fires 'abort' again.
    if (options.signal?.aborted) onAbort();
    child.stdout?.on('data', (d: Buffer) => onData('stdout', decoders.stdout.write(d)));
    child.stderr?.on('data', (d: Buffer) => onData('stderr', decoders.stderr.write(d)));

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
    runCleanups();
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      for (const child of running) killTree(child);
      runCleanups();
      process.kill(process.pid, signal);
    });
  }
}

const cleanups = new Set<() => void>();

function runCleanups(): void {
  for (const cleanup of [...cleanups]) {
    cleanups.delete(cleanup);

    try {
      cleanup();
    } catch {
      // Best effort while exiting: one failed cleanup must not stop the others.
    }
  }
}

/**
 * Run `cleanup` (synchronously) if the process exits or is ended by SIGINT or SIGTERM before the returned function
 * is called, after the child processes are killed; `finally` blocks do not run in those cases. Returns the function
 * that unregisters it.
 */
export function onExitCleanup(cleanup: () => void): () => void {
  installExitHook();
  cleanups.add(cleanup);

  return () => {
    cleanups.delete(cleanup);
  };
}

/**
 * Node.js flags that keep the inspector of a process closed to SIGUSR1: `--disable-sigusr1` where the running Node.js
 * has it (22.14 and later), else none. Otherwise code under test could send SIGUSR1 to its parent (the runner,
 * mutator) and open the inspector there, to run code outside the test it is in. Passed on the command line of the
 * processes Veritas starts with its own Node.js, never in NODE_OPTIONS: that reaches every `node` the tests start,
 * and an older Node.js (or Electron) refuses to start with an option it does not know there. Workers the runner forks
 * inherit it through `process.execArgv`.
 */
export function closedInspectorFlags(): string[] {
  return process.allowedNodeEnvironmentFlags.has('--disable-sigusr1') ? ['--disable-sigusr1'] : [];
}

/** Kill a child and everything it started: its descendants (found by parent pid, including ones that started their
 * own process group) and its process group on POSIX, `taskkill /T` on Windows. A process that was re-parented
 * before this runs (a daemon whose parent already exited) can no longer be found. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;

  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      for (const pid of descendants(child.pid)) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // not a group leader
        }

        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    // already gone
  }
  child.kill('SIGKILL');
}

/** Every process below `root` by parent pid (POSIX `ps`). */
function descendants(root: number): number[] {
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 5_000 });

  if (ps.status !== 0) return [];
  const children = new Map<number, number[]>();

  for (const line of ps.stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);

    if (!pid || ppid === undefined || Number.isNaN(ppid)) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const out: number[] = [];
  const queue = [root];

  while (queue.length > 0) {
    const next = queue.shift() as number;

    for (const pid of children.get(next) ?? []) {
      out.push(pid);
      queue.push(pid);
    }
  }

  return out;
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

  if (platform !== 'win32') return { command: name, prefix: [] };
  const ext = path.extname(name).toLowerCase();

  if (ext === '.cmd' || ext === '.bat') {
    // An explicit batch file: only an npm/pnpm shim can be run (through its Node.js script).
    const script = existsSync(name) ? shimTarget(name) : null;

    return script ? { command: process.execPath, prefix: [script] } : null;
  }

  if (/[\\/]/.test(name) || ext) return { command: name, prefix: [] };
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

/**
 * Run the project's own tests (the test runner, mutator) the way `pnpm test` would, with an allowlisted environment
 * and an empty temporary home directory, so nothing under the user's real home is found through HOME.
 * This is not a sandbox: test code runs with the user's file and network access (see the threat model).
 */
export async function runProjectTests(
  command: string,
  args: string[],
  options: RunCommandOptions & { memoryMb?: number },
): Promise<CommandResult> {
  const home = mkdtempSync(path.join(tmpdir(), 'veritas-home-'));
  // NODE_OPTIONS is not in the environment allowlist, so the user's own value never reaches the tests; the
  // memory limit (limits.memoryMb) is the only option set, and every Node.js process the runner starts inherits it.
  const memory = nodeMemoryFlags(options.memoryMb);
  // Started with this very Node.js, the runner gets the flags it is known to accept (see `closedInspectorFlags`).
  const flags = command === process.execPath ? closedInspectorFlags() : [];

  try {
    return await runCommand(command, [...flags, ...args], {
      ...options,
      env: {
        ...(options.env ?? {}),
        HOME: home,
        USERPROFILE: home,
        ...(memory.length ? { NODE_OPTIONS: memory.join(' ') } : {}),
      },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
