import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { type CommandResult, DEFAULT_ENV_ALLOWLIST, type RunCommandOptions, runCommand } from './process.js';
import { logEvent } from './run-context.js';

/**
 * Git reads the repository's own configuration (`.git/config`), which can name commands to run. Veritas runs git on
 * repositories it analyses (and on packages linked into them), including in steps that otherwise never execute project
 * code, so every git call goes through these options. What each covers, for the subcommands Veritas uses (`rev-parse`,
 * `ls-files`, `check-ignore`, `log`, `diff`, `config --get`, `remote get-url`):
 *
 * - `core.fsmonitor=false`: commands that read the index (`ls-files`, `check-ignore`, `diff`, `rev-parse` in some
 *   modes) would otherwise start the configured file system monitor command.
 * - `log.showSignature=false`: `log` would otherwise run `gpg.program` to verify commit signatures.
 * - `--no-pager`: `core.pager` and `pager.<cmd>` are never started (output is not a terminal either).
 * - `--no-optional-locks`: no index refresh is written while reading.
 * - `--ignore-submodules=all` on every diff against the working tree (added by `gitOutput`): a diff would otherwise
 *   start a git in each submodule to see whether it is dirty, with the submodule's own configuration (filters and
 *   monitor included). `diff.ignoreSubmodules=all` and `submodule.recurse=false` are set too, as defaults, but a
 *   submodule's `ignore` in `.gitmodules` overrides the first.
 * - git itself is taken only from PATH entries that cannot be the repository's (see `gitPathEntries`).
 * - `GIT_TERMINAL_PROMPT=0` and the allowlisted environment: no prompt, and no `GIT_*` override from the caller.
 * - Diffs are run with `--no-ext-diff --no-textconv` by their callers (`diff.external`, `diff.<driver>.command` and
 *   `.textconv`). A diff against the working tree could still run a configured clean filter
 *   (`filter.<driver>.clean` / `.process`) on files whose attributes name it: `gitOutput` refuses such a diff when the
 *   repository configures any filter (see `worktreeContent`).
 *
 * Not set, because none of these subcommands use them: `core.hooksPath` (hooks run on commits, checkouts and merges),
 * `core.sshCommand`, `credential.helper`, `core.gitProxy` and transport protocols (network commands only),
 * `core.editor` (interactive commands only).
 */
export const SAFE_GIT_OPTIONS: readonly string[] = [
  '--no-pager',
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'log.showSignature=false',
  // Defaults only: a submodule's `ignore` setting in .gitmodules overrides them, so diffs that read the working tree
  // also pass --ignore-submodules=all (see `gitOutput`), which nothing overrides.
  '-c',
  'diff.ignoreSubmodules=all',
  '-c',
  'submodule.recurse=false',
];

/** Git's arguments with `SAFE_GIT_OPTIONS` in front. */
export function gitArgs(args: string[]): string[] {
  return [...SAFE_GIT_OPTIONS, ...args];
}

/** Extra environment for git, on top of the allowlist every child process gets. */
export const GIT_ENV: Readonly<Record<string, string>> = { GIT_TERMINAL_PROMPT: '0' };

function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};

  for (const name of DEFAULT_ENV_ALLOWLIST) {
    const value = process.env[name];

    if (value !== undefined) env[name] = value;
  }

  return { ...env, ...GIT_ENV };
}

const GIT_TIMEOUT_MS = 30_000;

function executable(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(file).isFile()) return false;

    if (platform !== 'win32') accessSync(file, constants.X_OK);

    return true;
  } catch {
    return false;
  }
}

function within(p: string, dir: string, platform: NodeJS.Platform): boolean {
  const lib = platform === 'win32' ? path.win32 : path.posix;
  const rel = lib.relative(dir, p);

  return rel === '' || (rel !== '..' && !rel.startsWith(`..${lib.sep}`) && !lib.isAbsolute(rel));
}

/** The real path of `p` where it exists on this machine, else `p` resolved. */
function realOrResolved(p: string, platform: NodeJS.Platform): string {
  const lib = platform === 'win32' ? path.win32 : path.posix;

  if (platform === process.platform) {
    try {
      return realpathSync(p);
    } catch {
      /* missing: compare it as written */
    }
  }

  return lib.resolve(p);
}

/**
 * The nearest directory at or above `start` with a `.git` entry (no git is run to find it), below the user's home
 * directory, or null. The home directory and its parents never count: a dotfiles repository there would make every
 * tool under the home (`~/.local/bin`, version manager shims) part of the repository.
 */
function enclosingRepository(start: string): string | null {
  const home = realOrResolved(homedir(), process.platform);

  for (
    let dir = realOrResolved(start, process.platform);
    !within(home, dir, process.platform);
    dir = path.dirname(dir)
  ) {
    if (existsSync(path.join(dir, '.git'))) return dir;

    if (path.dirname(dir) === dir) return null;
  }

  return null;
}

/** A PATH entry git is not taken from, and why. */
export interface SkippedPathEntry {
  dir: string;
  reason: string;
}

/**
 * The PATH entries git may be taken from, in order, and the ones skipped with the reason:
 * - entries that are not absolute (an empty entry or `.` is the working directory, which is the repository): on
 *   Windows, only a drive-letter path (`C:\...`) or a UNC path counts, not a root-relative `\bin`;
 * - entries with a `node_modules` segment: npm scripts, `npx` and `pnpm exec` put `node_modules/.bin` directories
 *   first, and any dependency can install a `git` there;
 * - entries inside one of `excluded` (the repository git runs in, the analysed project), compared by real path: files
 *   there are the repository's, not tools of the user.
 */
export function classifyGitPathEntries(
  pathValue: string,
  platform: NodeJS.Platform,
  excluded: readonly string[] = [],
): { kept: string[]; skipped: SkippedPathEntry[] } {
  const lib = platform === 'win32' ? path.win32 : path.posix;
  const absolute =
    platform === 'win32'
      ? (dir: string) => /^[A-Za-z]:[\\/]/.test(dir) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(dir)
      : (dir: string) => lib.isAbsolute(dir);
  const roots = excluded.map((root) => ({
    root,
    real: realOrResolved(root, platform),
    resolved: lib.resolve(root),
  }));
  const kept: string[] = [];
  const skipped: SkippedPathEntry[] = [];

  for (const dir of pathValue.split(platform === 'win32' ? ';' : ':')) {
    if (dir === '' || !absolute(dir)) {
      skipped.push({ dir, reason: 'not an absolute path, so it would be looked up from the repository' });
      continue;
    }

    if (lib.normalize(dir).split(/[\\/]/).includes('node_modules')) {
      skipped.push({ dir, reason: 'a node_modules directory, where any installed package can put a git' });
      continue;
    }
    const real = realOrResolved(dir, platform);
    const inside = roots.find(
      (r) => within(real, r.real, platform) || within(lib.resolve(dir), r.resolved, platform),
    );

    if (inside) {
      skipped.push({
        dir,
        reason: `inside ${inside.root}, which the analysed repository could have put there`,
      });
      continue;
    }
    kept.push(dir);
  }

  return { kept, skipped };
}

/** The PATH entries git may be taken from (see `classifyGitPathEntries`). */
export function gitPathEntries(
  pathValue: string,
  platform: NodeJS.Platform,
  excluded: readonly string[] = [],
): string[] {
  return classifyGitPathEntries(pathValue, platform, excluded).kept;
}

/**
 * The absolute path of git from the PATH entries `gitPathEntries` keeps, or null when there is none. Git is spawned by
 * that path, so a `git` or `git.exe` in the repository (which Windows searches before PATH) never runs. When none is
 * left but a skipped entry has one, a warning names it and why, since git features then turn off.
 */
export function gitExecutable(
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; excluded?: readonly string[] } = {},
): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const name = platform === 'win32' ? 'git.exe' : 'git';
  const { kept, skipped } = classifyGitPathEntries(env.PATH ?? env.Path ?? '', platform, options.excluded);

  for (const dir of kept) {
    const file = join(dir, name);

    if (executable(file, platform)) return file;
  }

  for (const entry of skipped) {
    if (entry.dir !== '' && executable(join(entry.dir, name), platform)) {
      logEvent(
        'warn',
        `git in ${entry.dir} was not used: ${entry.reason}; git features are off for this run`,
        {
          event: 'git-not-used',
        },
      );
    }
  }

  return null;
}

/** What git must not be taken from when it runs in `cwd`: `cwd`, the repository holding it, and `extra` roots. */
function excludedFor(cwd: string, extra: readonly string[] = []): string[] {
  const repository = enclosingRepository(cwd);

  return [cwd, ...(repository ? [repository] : []), ...extra];
}

/** Run git synchronously with the safe options; the exit status (null when it could not run or timed out) and output. */
export function gitRun(
  cwd: string,
  args: string[],
  options: { timeoutMs?: number; excluded?: readonly string[] } = {},
): { status: number | null; stdout: string } {
  const git = gitExecutable({ excluded: excludedFor(cwd, options.excluded) });

  if (git === null) return { status: null, stdout: '' };
  const run = spawnSync(git, gitArgs(args), {
    cwd,
    env: gitEnv(),
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });

  return { status: run.error ? null : run.status, stdout: run.stdout?.toString() ?? '' };
}

/** Run git asynchronously (see `runCommand`) with the safe options and the git found by `gitExecutable`. */
export async function runGit(
  cwd: string,
  args: string[],
  options: Omit<RunCommandOptions, 'cwd'>,
): Promise<CommandResult> {
  const git = gitExecutable({ excluded: excludedFor(cwd) });

  if (git === null) {
    return {
      command: 'git',
      args,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      durationMs: 0,
      timedOut: false,
      spawnError: 'git was not found on PATH',
    };
  }

  return runCommand(git, gitArgs(args), { ...options, cwd, env: { ...(options.env ?? {}), ...GIT_ENV } });
}

/**
 * Whether git would run a content filter command on working tree files that the repository, not the user, configured:
 * any `filter.*` key whose scope is not the user's (`global`) or the system's, such as the repository's
 * `.git/config`, its worktree configuration or a file either includes. Filters from the user's own configuration (such
 * as Git LFS) are the user's tools. When git cannot tell, it is taken as configured.
 */
export function gitConfiguresFilters(root: string): boolean {
  const run = gitRun(root, ['config', '--includes', '--show-scope', '--get-regexp', '^filter\\.']);

  // 1: no such key at all.
  if (run.status === 1) return false;

  if (run.status !== 0) return true;

  return run.stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .some((line) => !/^(global|system)\t/.test(line));
}

/**
 * Output of a git command, or null when git fails. With `worktreeContent` (a diff against the working tree), null
 * also when the repository configures a content filter, which git would run on the files it compares, and the diff
 * never looks into submodules.
 */
export function gitOutput(
  root: string,
  args: string[],
  options: { worktreeContent?: boolean } = {},
): string | null {
  if (options.worktreeContent && gitConfiguresFilters(root)) return null;
  // Right after the subcommand, where nothing (not even .gitmodules) overrides it.
  const run = gitRun(
    root,
    options.worktreeContent ? [args[0] ?? '', '--ignore-submodules=all', ...args.slice(1)] : args,
  );

  return run.status === 0 ? run.stdout : null;
}
