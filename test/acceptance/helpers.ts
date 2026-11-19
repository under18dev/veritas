import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CLI = path.join(REPO_ROOT, 'packages/cli/dist/bin.js');

/** Copy a fixture outside the monorepo so its dependency resolution is not influenced by ours. */
export function copyFixture(name: string, options: { git?: boolean; linkDeps?: boolean } = {}): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `veritas-${name}-`)));
  const source = path.join(REPO_ROOT, 'fixtures', name);
  cpSync(source, dir, {
    recursive: true,
    filter: (src) => !src.includes('node_modules') && !src.includes('.mutator'),
  });
  // Fixture dependencies (vitest, mutator) are installed in the workspace; link them instead of reinstalling.
  if (options.linkDeps && existsSync(path.join(source, 'node_modules')))
    linkPackages(path.join(source, 'node_modules'), path.join(dir, 'node_modules'));
  if (options.git) {
    const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    git('-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'add', '-A');
    git('-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'fixture');
  }
  return dir;
}

/**
 * Link every installed package to its real location. Linking the whole node_modules directory is not enough on
 * Windows: pnpm's relative links inside it would resolve against the junction instead of the real directory.
 */
function linkPackages(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    if (entry === '.bin' || entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      linkPackages(path.join(from, entry), path.join(to, entry));
      continue;
    }
    symlinkSync(realpathSync(path.join(from, entry)), path.join(to, entry), 'junction');
  }
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
