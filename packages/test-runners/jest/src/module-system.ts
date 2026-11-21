import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const BABEL_CONFIGS = [
  'babel.config.js',
  'babel.config.cjs',
  'babel.config.mjs',
  'babel.config.cts',
  'babel.config.json',
  '.babelrc',
  '.babelrc.js',
  '.babelrc.cjs',
  '.babelrc.mjs',
  '.babelrc.json',
];

/** Transformers that usually compile tests to CommonJS, where `jest.mock` is hoisted above the imports it replaces. */
const COMMONJS_TRANSFORMERS = ['ts-jest', '@swc/jest', 'esbuild-jest', '@side/jest-runtime'];

/**
 * Whether the project's Jest tests run as native ES modules, as far as can be told without running anything: the
 * package is `"type": "module"`, and nothing in it compiles tests to CommonJS (no Babel config, no ts-jest or another
 * compiling transformer among its dependencies). Jest links a native ES module's static imports before any of its
 * code runs, so `jest.mock` there cannot replace them. When any of this is unclear the answer is false, and
 * `jest.mock` keeps counting as a mock: that gives a test less credit, never more.
 */
export function runsNativeEsm(root: string): boolean {
  let manifest: Record<string, unknown>;

  try {
    manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return false;
  }

  if (manifest.type !== 'module' || 'babel' in manifest) return false;
  const deps = {
    ...((manifest.dependencies as object | undefined) ?? {}),
    ...((manifest.devDependencies as object | undefined) ?? {}),
  };

  if (COMMONJS_TRANSFORMERS.some((name) => name in deps)) return false;

  return !BABEL_CONFIGS.some((file) => existsSync(path.join(root, file)));
}
