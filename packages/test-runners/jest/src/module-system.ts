import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { findJestConfig } from './mutation-config.js';

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
 * compiling transformer among its dependencies, and a Jest config with no `transform` other than an empty one and no
 * `preset`). Jest links a native ES module's static imports before any of its
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

  if (BABEL_CONFIGS.some((file) => existsSync(path.join(root, file)))) return false;

  return !jestConfigTransforms(root, manifest);
}

/**
 * Whether the project's Jest config may compile tests (a `transform` that is not empty, such as babel-jest with
 * inline presets, or a `preset`), read without running it: a JSON config and the `jest` key of package.json as data,
 * a JavaScript or TypeScript config as text. A config that cannot be read counts as one that may.
 */
function jestConfigTransforms(root: string, manifest: Record<string, unknown>): boolean {
  const file = findJestConfig(root);
  const fromData = (config: unknown) => {
    if (!config || typeof config !== 'object') return false;
    const { transform, preset } = config as Record<string, unknown>;
    const emptyTransform =
      transform === undefined ||
      (transform !== null && typeof transform === 'object' && Object.keys(transform).length === 0);

    return !emptyTransform || preset !== undefined;
  };

  if (file === null) return fromData(manifest.jest);
  let text: string;

  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return true;
  }

  if (file.endsWith('.json')) {
    try {
      return fromData(JSON.parse(text));
    } catch {
      return true;
    }
  }
  const code = text.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g, '$1');
  const keyed = (key: string) => new RegExp(`(?:^|[\\s{,])['"]?${key}['"]?\\s*:`, 'g');
  const transforms = [...code.matchAll(keyed('transform'))];
  // Only `transform: {}` is known to leave the tests alone.
  const onlyEmpty = transforms.every((match) =>
    /^\s*\{\s*\}/.test(code.slice((match.index ?? 0) + match[0].length)),
  );

  return !onlyEmpty || keyed('preset').test(code);
}
