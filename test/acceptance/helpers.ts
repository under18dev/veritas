import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CLI = path.join(REPO_ROOT, 'packages/cli/dist/bin.js');

/** Copy a fixture outside the monorepo so its dependency resolution is not influenced by ours. */
export function copyFixture(name: string, options: { git?: boolean } = {}): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `veritas-${name}-`)));
  cpSync(path.join(REPO_ROOT, 'fixtures', name), dir, { recursive: true });
  if (options.git) {
    const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    git('-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'add', '-A');
    git('-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'fixture');
  }
  return dir;
}

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function json<T = Record<string, unknown>>(result: CliResult): T {
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(`stdout is not pure JSON:\n${result.stdout}\n--- stderr ---\n${result.stderr}`);
  }
}
