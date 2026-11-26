import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import { type CommandResult, DEFAULT_ENV_ALLOWLIST, type RunCommandOptions, runCommand } from './process.js';

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
 * - `diff.ignoreSubmodules=all`, `submodule.recurse=false`: a diff would otherwise start a git in each submodule to
 *   see whether it is dirty, with the submodule's own configuration (filters and monitor included).
 * - git itself is found on the absolute entries of PATH only (see `gitExecutable`).
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
  // A diff that checks whether a submodule is dirty runs a git in the submodule, with the submodule's own
  // configuration (its filters, its monitor): submodules are never looked into.
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

/**
 * The absolute path of git, from the absolute entries of PATH only, or null when there is none. Git runs with the
 * repository as its working directory; a relative or empty PATH entry (and, on Windows, the working directory itself,
 * which is searched before PATH) would let a `git` or `git.exe` inside the repository run instead.
 */
export function gitExecutable(
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const separator = platform === 'win32' ? ';' : ':';
  const isAbsolute = platform === 'win32' ? path.win32.isAbsolute : path.posix.isAbsolute;
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const name = platform === 'win32' ? 'git.exe' : 'git';

  for (const dir of (env.PATH ?? env.Path ?? '').split(separator)) {
    if (!dir || !isAbsolute(dir)) continue;
    const file = join(dir, name);

    if (executable(file, platform)) return file;
  }

  return null;
}

/** Run git synchronously with the safe options; the exit status (null when it could not run or timed out) and output. */
export function gitRun(
  cwd: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): { status: number | null; stdout: string } {
  const git = gitExecutable();

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
  const git = gitExecutable();

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
 * also when the repository configures a content filter, which git would run on the files it compares.
 */
export function gitOutput(
  root: string,
  args: string[],
  options: { worktreeContent?: boolean } = {},
): string | null {
  if (options.worktreeContent && gitConfiguresFilters(root)) return null;
  const run = gitRun(root, args);

  return run.status === 0 ? run.stdout : null;
}
