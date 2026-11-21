import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { gitOutput } from '../artifacts/store.js';

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun' | 'unknown';

export interface ProjectInfo {
  root: string;
  hasPackageJson: boolean;
  packageManager: PackageManager;
  tsconfig: string | null;
  vitest: { declared: boolean; installedVersion: string | null; configFile: string | null };
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

const VITEST_CONFIGS = [
  'vitest.config.ts',
  'vitest.config.mts',
  'vitest.config.js',
  'vitest.config.mjs',
  'vite.config.ts',
  'vite.config.js',
];

function readPackageJson(root: string): Record<string, unknown> | null {
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

/**
 * The package manager the project uses. Lockfiles are read from the nearest directory, from `root` upwards, that has
 * one. A lockfile committed to git outweighs the `packageManager` field of package.json, which outweighs a lockfile
 * that is only on disk: running another package manager once leaves its lockfile behind (a `pnpm-lock.yaml` next to
 * the committed `package-lock.json`), and that does not change what the project uses.
 */
function detectPackageManager(root: string, pkg: Record<string, unknown> | null): PackageManager {
  let dir = path.resolve(root);
  let present: [string, PackageManager][] = [];

  for (;;) {
    present = LOCKFILES.filter(([file]) => existsSync(path.join(dir, file)));

    if (present.length > 0) break;
    const parent = path.dirname(dir);

    if (parent === dir) break;
    dir = parent;
  }
  // Read-only: `git ls-files` lists which of these lockfiles are committed; null outside a repository.
  const committed = new Set(
    present.length > 0
      ? (gitOutput(dir, ['ls-files', '--', ...present.map(([file]) => file)]) ?? '')
          .split('\n')
          .map((line) => line.trim())
      : [],
  );
  const declared =
    typeof pkg?.packageManager === 'string'
      ? (pkg.packageManager.split('@')[0] as PackageManager)
      : undefined;

  return present.find(([file]) => committed.has(file))?.[1] ?? declared ?? present[0]?.[1] ?? 'unknown';
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

/** Inspect a project without running any of its code. */
export function detectProject(root: string): ProjectInfo {
  const pkg = readPackageJson(root);
  const deps = { ...((pkg?.dependencies as object) ?? {}), ...((pkg?.devDependencies as object) ?? {}) };
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

  // Only when such a file uses Vitest: a `src/test.ts` utility or a `__tests__/fixtures.ts` alone is not a test.
  const usesVitest = (name: string, parent: string) => {
    try {
      // `import { it } from 'vitest'`, `import 'vitest'` or `require('vitest')`.
      return /(?:from\s+|import\s+|require\(\s*)['"]vitest['"]/.test(
        readFileSync(path.join(parent, name), 'utf8'),
      );
    } catch {
      return false;
    }
  };

  if (
    hasFileNamed(root, (name, parent) => /^test\.(?:ts|tsx|js|mjs)$/.test(name) && usesVitest(name, parent))
  )
    testGlobs.push(`**/test.${EXTENSIONS}`);

  if (
    hasFileNamed(
      root,
      (name, parent) =>
        parent.split(path.sep).includes('__tests__') &&
        /\.(?:ts|tsx|js|mjs)$/.test(name) &&
        !/\.(?:test|spec)\./.test(name) &&
        usesVitest(name, parent),
    )
  )
    testGlobs.push(`**/__tests__/**/*.${EXTENSIONS}`);

  return {
    root,
    hasPackageJson: pkg !== null,
    packageManager: ['pnpm', 'npm', 'yarn', 'bun'].includes(packageManager) ? packageManager : 'unknown',
    tsconfig: existsSync(path.join(root, 'tsconfig.json')) ? 'tsconfig.json' : null,
    vitest: {
      declared: 'vitest' in deps,
      installedVersion: resolvePackageVersion(root, 'vitest'),
      configFile: VITEST_CONFIGS.find((f) => existsSync(path.join(root, f))) ?? null,
    },
    git: findUp(root, '.git'),
    plugAndPlay: ['.pnp.cjs', '.pnp.js'].some((f) => findUp(root, f)),
    sourceGlobs,
    testGlobs,
  };
}
