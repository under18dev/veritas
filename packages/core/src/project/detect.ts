import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { gitOutput } from '../git.js';
import type { TestRunnerInstallation, TestRunnerProvider } from '../test-runner.js';

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun' | 'unknown';

export interface ProjectInfo {
  root: string;
  hasPackageJson: boolean;
  packageManager: PackageManager;
  tsconfig: string | null;
  /** The configured test runner as installed in the project. */
  testRunner: TestRunnerInstallation;
  git: boolean;
  /** Yarn Plug'n'Play (`.pnp.cjs`): dependencies are not in node_modules, which Veritas resolves from. */
  plugAndPlay: boolean;
  sourceGlobs: string[];
  testGlobs: string[];
}

const LOCKFILES: [string, PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
];

/** The parsed package.json at `root`, or null when there is none or it cannot be read. */
export function readPackageJson(root: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Version of a package installed for the project root, or null. Never executes the package. Looks the package up
 * in `node_modules` directories from `root` upwards, because some packages do not export their `package.json`.
 */
export function resolvePackageVersion(root: string, name: string): string | null {
  let dir = path.resolve(root);

  for (;;) {
    const manifest = path.join(dir, 'node_modules', ...name.split('/'), 'package.json');

    if (existsSync(manifest)) {
      try {
        return (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }).version ?? null;
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);

    if (parent === dir) return null;
    dir = parent;
  }
}

/** The manager named by the `packageManager` field of a package.json (`pnpm@9.0.0` is pnpm), if any. */
function declaredManager(pkg: Record<string, unknown> | null): PackageManager | undefined {
  return typeof pkg?.packageManager === 'string'
    ? (pkg.packageManager.split('@')[0] as PackageManager)
    : undefined;
}

/**
 * The package manager the project uses, looking from `root` up to the root of its git repository (without git, up to
 * the filesystem root). The nearest lockfile committed to git wins. Without one, the `packageManager` field of the
 * nearest package.json that has it (up to the git root, or without git up to the nearest lockfile) decides, and only
 * then the nearest lockfile that is on disk but not committed. Running another package manager once leaves its
 * lockfile behind (a `pnpm-lock.yaml` next to the committed `package-lock.json`, an untracked `package-lock.json` in
 * one workspace package), and that does not change what the project uses.
 */
function detectPackageManager(root: string, pkg: Record<string, unknown> | null): PackageManager {
  let start = path.resolve(root);

  try {
    start = realpathSync(start);
  } catch {
    /* keep the resolved path */
  }
  // Read-only git commands; null outside a repository.
  const top = gitOutput(start, ['rev-parse', '--show-toplevel'])?.trim() || null;
  const levels: string[] = [];

  for (let dir = start; ; ) {
    levels.push(dir);
    const parent = path.dirname(dir);

    if ((top !== null && path.relative(top, dir) === '') || parent === dir) break;
    dir = parent;
  }
  let onDisk: { dir: string; manager: PackageManager } | undefined;

  for (const dir of levels) {
    const present = LOCKFILES.filter(([file]) => existsSync(path.join(dir, file)));

    if (present.length === 0) continue;
    onDisk ??= { dir, manager: present[0]?.[1] ?? 'unknown' };

    if (top === null) continue;
    const committed = new Set(
      (gitOutput(dir, ['ls-files', '--', ...present.map(([file]) => file)]) ?? '')
        .split('\n')
        .map((line) => line.trim()),
    );
    const found = present.find(([file]) => committed.has(file));

    if (found) return found[1];
  }
  // Without git the nearest lockfile marks the project root, so no package.json above it is read.
  const fieldLevels =
    top !== null ? levels : onDisk ? levels.slice(0, levels.indexOf(onDisk.dir) + 1) : [start];

  for (const dir of fieldLevels) {
    const declared = declaredManager(dir === start ? pkg : readPackageJson(dir));

    if (declared) return declared;
  }

  return onDisk?.manager ?? 'unknown';
}

function findUp(start: string, name: string): boolean {
  let dir = start;

  for (;;) {
    if (existsSync(path.join(dir, name))) return true;
    const parent = path.dirname(dir);

    if (parent === dir) return false;
    dir = parent;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const EXTENSIONS = '{ts,tsx,js,mjs}';

/**
 * Directories of the workspace packages a root declares (`pnpm-workspace.yaml` `packages:`, or `workspaces` in
 * package.json), relative to the root. Literal paths and a trailing `*` are expanded; other patterns are skipped.
 */
export function workspacePackages(root: string, pkg: Record<string, unknown> | null): string[] {
  const patterns: string[] = [];
  const yaml = path.join(root, 'pnpm-workspace.yaml');

  if (existsSync(yaml)) {
    const text = readFileSync(yaml, 'utf8');
    const block = /^packages:\s*\n((?:[ \t]+-.*\n?|[ \t]*#.*\n?|[ \t]*\n)*)/m.exec(text)?.[1] ?? '';

    for (const line of block.split('\n')) {
      const value = /^[ \t]+-[ \t]*['"]?([^'"#\s]+)['"]?/.exec(line)?.[1];

      if (value) patterns.push(value);
    }
    // The flow form: `packages: ['packages/*', 'apps/*']`.
    const inline = /^packages:[ \t]*\[([^\]]*)\]/m.exec(text)?.[1];

    for (const item of inline?.split(',') ?? []) {
      const value = item.trim().replace(/^['"]|['"]$/g, '');

      if (value) patterns.push(value);
    }
  }
  const workspaces = pkg?.workspaces;
  const list = Array.isArray(workspaces)
    ? workspaces
    : workspaces &&
        typeof workspaces === 'object' &&
        Array.isArray((workspaces as { packages?: unknown }).packages)
      ? (workspaces as { packages: unknown[] }).packages
      : [];

  for (const value of list) if (typeof value === 'string') patterns.push(value);
  const dirs = new Set<string>();

  for (const pattern of patterns) {
    const clean = pattern.replace(/^\.\//, '').replace(/\/$/, '');

    if (clean.startsWith('!') || clean.includes('**') || clean === '.' || clean === '') continue;

    if (clean.endsWith('/*') && !clean.slice(0, -2).includes('*')) {
      const parent = path.join(root, clean.slice(0, -2));

      if (!isDir(parent)) continue;

      for (const entry of readdirSync(parent).sort())
        if (existsSync(path.join(parent, entry, 'package.json'))) dirs.add(`${clean.slice(0, -2)}/${entry}`);
    } else if (!clean.includes('*') && existsSync(path.join(root, clean, 'package.json'))) dirs.add(clean);
  }

  return [...dirs];
}

/** Whether any file below `dir` matches `name`, looking at no more than `limit` directories. */
function hasFileNamed(dir: string, test: (name: string, parent: string) => boolean, limit = 2000): boolean {
  const queue = [dir];

  for (let seen = 0; queue.length > 0 && seen < limit; seen++) {
    const current = queue.shift() as string;
    let entries: import('node:fs').Dirent[];

    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', 'dist', '.veritas'].includes(entry.name))
          queue.push(path.join(current, entry.name));
      } else if (test(entry.name, current)) return true;
    }
  }

  return false;
}

/** Whether source text imports or requires one of `modules` (`import { it } from 'vitest'`, `require('vitest')`). */
function importsModule(text: string, modules: readonly string[]): boolean {
  if (modules.length === 0) return false;
  const names = modules.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

  return new RegExp(`(?:from\\s+|import\\s+|require\\(\\s*)['"](?:${names})['"]`).test(text);
}

/** Whether source text calls one of `names` as a global (`describe(`, `it.each(...)(`), as a runner with globals has them. */
function callsGlobal(text: string, names: readonly string[]): boolean {
  if (names.length === 0) return false;
  const alternatives = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

  return new RegExp(`(?:^|[^.\\w$])(?:${alternatives})(?:\\.\\w+)*\\s*\\(`, 'm').test(text);
}

/** Inspect a project, and how it has the test runner `runner`, without running any of its code. */
export function detectProject(root: string, runner: TestRunnerProvider): ProjectInfo {
  const pkg = readPackageJson(root);
  const packageManager = detectPackageManager(root, pkg);
  const sourceDir = ['src', 'lib'].find((d) => isDir(path.join(root, d)));
  // Source of the workspace packages too, so a test that calls a package of the same repository reaches analysed code.
  const packageSources = workspacePackages(root, pkg).flatMap((dir) => {
    const sub = ['src', 'lib'].find((d) => isDir(path.join(root, dir, d)));

    return sub ? [`${dir}/${sub}/**/*.${EXTENSIONS}`] : [];
  });
  const sourceGlobs =
    sourceDir || packageSources.length > 0
      ? [...(sourceDir ? [`${sourceDir}/**/*.${EXTENSIONS}`] : []), ...packageSources]
      : [`**/*.${EXTENSIONS}`];
  // Test files named `test.ts` or kept under `__tests__/`, when the project has them, besides `*.test.ts`.
  const testGlobs = [`**/*.{test,spec}.${EXTENSIONS}`];

  // Only when such a file uses the test runner: a `src/test.ts` utility or a `__tests__/fixtures.ts` alone is not
  // a test.
  const usesRunner = (name: string, parent: string) => {
    try {
      const text = readFileSync(path.join(parent, name), 'utf8');

      return (
        importsModule(text, runner.recognition.modules) ||
        (runner.recognition.globals &&
          callsGlobal(text, [...runner.recognition.tests, ...runner.recognition.suites]))
      );
    } catch {
      return false;
    }
  };

  if (
    hasFileNamed(root, (name, parent) => /^test\.(?:ts|tsx|js|mjs)$/.test(name) && usesRunner(name, parent))
  )
    testGlobs.push(`**/test.${EXTENSIONS}`);

  if (
    hasFileNamed(
      root,
      (name, parent) =>
        parent.split(path.sep).includes('__tests__') &&
        /\.(?:ts|tsx|js|mjs)$/.test(name) &&
        !/\.(?:test|spec)\./.test(name) &&
        usesRunner(name, parent),
    )
  )
    testGlobs.push(`**/__tests__/**/*.${EXTENSIONS}`);

  return {
    root,
    hasPackageJson: pkg !== null,
    packageManager: ['pnpm', 'npm', 'yarn', 'bun'].includes(packageManager) ? packageManager : 'unknown',
    tsconfig: existsSync(path.join(root, 'tsconfig.json')) ? 'tsconfig.json' : null,
    testRunner: runner.detection.detect(root, pkg),
    git: findUp(root, '.git'),
    plugAndPlay: ['.pnp.cjs', '.pnp.js'].some((f) => findUp(root, f)),
    sourceGlobs,
    testGlobs,
  };
}
