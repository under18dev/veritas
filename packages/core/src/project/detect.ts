import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun' | 'unknown';

export interface ProjectInfo {
  root: string;
  hasPackageJson: boolean;
  packageManager: PackageManager;
  tsconfig: string | null;
  vitest: { declared: boolean; installedVersion: string | null; configFile: string | null };
  git: boolean;
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

/** Version of a package resolvable from the project root, or null. Never executes the package. */
export function resolvePackageVersion(root: string, name: string): string | null {
  try {
    const require = createRequire(path.join(root, 'package.json'));
    const file = require.resolve(`${name}/package.json`);
    return (JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
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

/** Inspect a project without running any of its code. */
export function detectProject(root: string): ProjectInfo {
  const pkg = readPackageJson(root);
  const deps = { ...((pkg?.dependencies as object) ?? {}), ...((pkg?.devDependencies as object) ?? {}) };
  const packageManager =
    LOCKFILES.find(([file]) => findUp(root, file))?.[1] ??
    (typeof pkg?.packageManager === 'string'
      ? (pkg.packageManager.split('@')[0] as PackageManager)
      : 'unknown');
  const sourceDir = ['src', 'lib'].find((d) => isDir(path.join(root, d)));
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
    sourceGlobs: sourceDir ? [`${sourceDir}/**/*.{ts,tsx,js,mjs}`] : ['**/*.{ts,tsx,js,mjs}'],
    testGlobs: ['**/*.{test,spec}.{ts,tsx,js,mjs}'],
  };
}
