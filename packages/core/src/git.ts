import { execFileSync, spawnSync } from 'node:child_process';
import { DEFAULT_ENV_ALLOWLIST } from './process.js';

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

/** Run git synchronously with the safe options; the exit status (null when it could not run or timed out) and output. */
export function gitRun(
  cwd: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): { status: number | null; stdout: string } {
  const run = spawnSync('git', gitArgs(args), {
    cwd,
    env: gitEnv(),
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });

  return { status: run.error ? null : run.status, stdout: run.stdout?.toString() ?? '' };
}

/**
 * Whether the repository at `root` configures a content filter command in its own configuration (`.git/config` and
 * what it includes), which git runs on working tree files. Filters from the user's own configuration (such as Git
 * LFS) are the user's tools and do not count.
 */
export function gitConfiguresFilters(root: string): boolean {
  const run = gitRun(root, [
    'config',
    '--local',
    '--includes',
    '--get-regexp',
    '^filter\\..*\\.(clean|smudge|process)$',
  ]);

  // 1: no such key. Anything else but 0 means git could not tell; assume there may be one.
  return run.status !== 1;
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

  try {
    return execFileSync('git', gitArgs(args), {
      cwd: root,
      env: gitEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    }).toString();
  } catch {
    return null;
  }
}
