import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Jest's config files at the project root, in the order Jest looks for them. */
export const JEST_CONFIG_FILES = [
  'jest.config.js',
  'jest.config.ts',
  'jest.config.mjs',
  'jest.config.cjs',
  'jest.config.cts',
  'jest.config.json',
];

/** The project's Jest config file (absolute), found the way Jest finds it, or null (then package.json `jest` is used). */
export function findJestConfig(root: string): string | null {
  for (const name of JEST_CONFIG_FILES) {
    const file = path.join(root, name);

    if (existsSync(file)) return file;
  }

  return null;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));

    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Why @mizchi/mutator cannot run the project's Jest tests, from what can be read without running anything; null when
 * nothing stands in the way (what only shows when Jest loads the config, such as functions in it, is reported by the
 * run itself). Its Jest integration starts Jest with `node --experimental-vm-modules` and supports native ESM
 * projects only, and it refuses a config with `projects`.
 */
export function mutationUnsupportedReason(root: string): string | null {
  const manifest = readJson(path.join(root, 'package.json'));

  if (manifest?.type !== 'module')
    return '@mizchi/mutator runs Jest only in native ESM projects ("type": "module" in package.json); this project is not one, so mutation testing is not run';
  const configFile = findJestConfig(root);
  const config = configFile
    ? configFile.endsWith('.json')
      ? readJson(configFile)
      : null
    : (manifest.jest as Record<string, unknown> | undefined);

  if (config && typeof config === 'object' && 'projects' in config)
    return '@mizchi/mutator does not support Jest configs with `projects`, so mutation testing is not run';

  // A JavaScript or TypeScript config is not run here: a `projects:` key written in it is enough to stop, and one
  // built some other way surfaces as mutator's own error.
  if (configFile && !configFile.endsWith('.json')) {
    let text = '';

    try {
      text = readFileSync(configFile, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    } catch {
      // Unreadable: mutator reports it.
    }

    if (/(?:^|[\s{,])['"]?projects['"]?\s*:/.test(text))
      return `@mizchi/mutator does not support Jest configs with \`projects\`, and ${path.basename(configFile)} sets them, so mutation testing is not run`;
  }

  return null;
}

/**
 * The part of a generated config that limits Jest to `files`. Jest matches `testRegex` against each test's real path
 * in the platform's form, so every file is matched in the form given and in its real long form (on Windows a short
 * 8.3 name may stand for it), with either separator and either case of the drive letter.
 */
const SELECT_TESTS = String.raw`if (files !== null) {
  const escape = (s) => s.replace(/[.*+?^{}$()|[\]\\]/g, '\\$&');
  const real = (f) => {
    try {
      return realpathSync.native(f);
    } catch {
      return f;
    }
  };
  const drive = (part) => '[' + part[0].toUpperCase() + part[0].toLowerCase() + ']:';
  const pattern = (f) =>
    '^' +
    f
      .split(/[\\/]/)
      .map((part, i) => (i === 0 && /^[A-Za-z]:$/.test(part) ? drive(part) : escape(part)))
      .join('[\\\\/]') +
    '$';
  delete config.testMatch;
  config.testRegex = [...new Set(files.flatMap((f) => [f, real(f)]))].map(pattern);
}`;

/**
 * Write a Jest config for one mutation run that is the project's own (its config file, or the `jest` key of
 * package.json), with `rootDir` made absolute because the file lives outside the project root, and, with `testFiles`
 * (POSIX, relative to `root`), limited to those tests: mutator runs its baseline and every mutant with the tests this
 * config selects. The project's own jest-config reads its config when mutator reads this one, the way Jest reads it
 * (TypeScript configs included); Veritas never runs it.
 */
export function writeMutationJestConfig(options: {
  root: string;
  dir: string;
  testFiles?: string[];
}): string {
  const root = path.resolve(options.root);
  const base = findJestConfig(root);
  const file = path.join(options.dir, 'jest.mutation.config.mjs');
  const absolute = options.testFiles?.map((test) => path.join(root, test)) ?? null;
  const lines = [
    '// Written by Veritas for one mutation run: the project Jest config, limited to the tests that',
    '// import the mutated code. Safe to delete.',
    "import { realpathSync } from 'node:fs';",
    "import { createRequire } from 'node:module';",
    "import path from 'node:path';",
    `const projectDir = ${JSON.stringify(root)};`,
    `const baseFile = ${JSON.stringify(base)};`,
    `const files = ${JSON.stringify(absolute)};`,
    "// The project config is read by the jest-config of the project's own Jest, as Jest reads it (TypeScript",
    '// configs included), never imported directly.',
    "const fromProject = createRequire(path.join(projectDir, 'package.json'));",
    "const fromJest = createRequire(fromProject.resolve('jest/package.json'));",
    "const jestConfig = createRequire(fromJest.resolve('jest-cli/package.json'))('jest-config');",
    'const { config: base } = await jestConfig.readInitialOptions(baseFile ?? undefined, {',
    '  packageRootOrConfig: baseFile ?? projectDir,',
    '});',
    'const config = { ...base, rootDir: base.rootDir ? path.resolve(projectDir, base.rootDir) : projectDir };',
    SELECT_TESTS,
    'export default config;',
    '',
  ];
  writeFileSync(file, lines.join('\n'));

  return file;
}
