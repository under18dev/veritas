import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CONFIG_NAMES = ['vitest', 'vite'].flatMap((base) =>
  ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].map((ext) => `${base}.config.${ext}`),
);

/** The project's Vitest config file, found the way Vitest finds it. */
export function findVitestConfig(root: string): string | null {
  for (const name of CONFIG_NAMES) {
    const file = path.join(root, name);

    if (existsSync(file)) return file;
  }

  return null;
}

/** Directories the project's Vite must also allow files from, and how to find its default allow list. */
export interface FsAllow {
  /** Absolute directories outside the project, such as the bundled mutator's, whose files Vitest loads. */
  dirs: string[];
  /** `file:` URL of the project's Vite, whose `searchForWorkspaceRoot` gives the default allow list; null if unknown. */
  viteUrl: string | null;
}

/**
 * Write a Vitest config for one mutation run that is the project's own, changed in two ways only:
 * - with `testFiles` (POSIX, relative to `root`), limited to those tests. mutator runs its baseline and every mutant
 *   with the tests this config selects, and it has no other way to choose tests. Inline `test.projects` keep only
 *   the files their include/exclude globs match; projects defined in other files cannot be narrowed and are kept.
 * - with `fsAllow`, Vite's `server.fs.allow` also lists those directories. The mutator bundled with Veritas has
 *   Vitest load its setup file from outside the project, which Vite (before 8) refuses: every test then fails
 *   with "Cannot find module '/@fs/…'". Vite's default (the workspace root) is kept, and `strict` is left alone.
 */
export function writeMutationVitestConfig(options: {
  root: string;
  dir: string;
  testFiles?: string[];
  fsAllow?: FsAllow;
}): string {
  const root = path.resolve(options.root);
  const base = findVitestConfig(root);
  const file = path.join(options.dir, 'vitest.mutation.config.mjs');
  const absolute = options.testFiles?.map((test) => path.join(root, test)) ?? null;
  const lines = [
    '// Written by Veritas for one mutation run: the project Vitest config, limited to the tests that',
    '// import the mutated code and allowing the files of the mutator that runs them. Safe to delete.',
    "import path from 'node:path';",
    base
      ? `import * as baseModule from ${JSON.stringify(pathToFileURL(base).href)};`
      : 'const baseModule = {};',
    `const configDir = ${JSON.stringify(root)};`,
    `const files = ${JSON.stringify(absolute)};`,
    `const allowDirs = ${JSON.stringify(options.fsAllow?.dirs ?? [])};`,
    `const viteUrl = ${JSON.stringify(options.fsAllow?.viteUrl ?? null)};`,
    'const matches = (relative, globs) => globs.some((glob) => path.posix.matchesGlob(relative, glob));',
    'const select = (test, vitestRoot) => {',
    '  if (files === null) return test?.include;',
    "  const relative = files.map((f) => path.relative(vitestRoot, f).split(path.sep).join('/'));",
    '  return relative.filter(',
    '    (f) => (!test?.include || matches(f, test.include)) && !(test?.exclude && matches(f, test.exclude)),',
    '  );',
    '};',
    'const withInclude = (test, include) => (include === undefined ? test : { ...test, include });',
    "// Setting server.fs.allow replaces Vite's default, the workspace root, so it is listed first.",
    'const allowing = async (config, vitestRoot) => {',
    '  if (allowDirs.length === 0) return config;',
    '  const server = config.server ?? {};',
    '  const fs = server.fs ?? {};',
    '  let allow = fs.allow;',
    '  if (!allow) {',
    '    allow = [vitestRoot];',
    '    try {',
    '      if (viteUrl) allow = [(await import(viteUrl)).searchForWorkspaceRoot(vitestRoot)];',
    '    } catch {}',
    '  }',
    '  return { ...config, server: { ...server, fs: { ...fs, allow: [...allow, ...allowDirs] } } };',
    '};',
    'export default async (env) => {',
    '  let base = baseModule.default ?? {};',
    "  if (typeof base === 'function') base = await base(env);",
    '  base = (await base) ?? {};',
    '  const vitestRoot = base.root ? path.resolve(configDir, base.root) : configDir;',
    '  const test = base.test ?? {};',
    '  if (!Array.isArray(test.projects))',
    '    return allowing({ ...base, root: vitestRoot, test: withInclude(test, select(test, vitestRoot)) }, vitestRoot);',
    '  const projects = [];',
    '  for (const entry of test.projects) {',
    "    if (!entry || typeof entry !== 'object') {",
    '      projects.push(entry);',
    '      continue;',
    '    }',
    '    const projectRoot = entry.root ? path.resolve(vitestRoot, entry.root) : vitestRoot;',
    '    const include = select(entry.test, projectRoot);',
    '    if (include === undefined || include.length > 0)',
    '      projects.push({ ...entry, test: withInclude(entry.test, include) });',
    '  }',
    '  return allowing({ ...base, root: vitestRoot, test: { ...test, projects } }, vitestRoot);',
    '};',
    '',
  ];
  writeFileSync(file, lines.join('\n'));

  return file;
}

/**
 * `file:` URL of the Vite that the project's Vitest uses, found without running either. Null when either cannot
 * be found, or Vite's package does not say where its ES module entry is.
 */
export function projectViteUrl(root: string): string | null {
  try {
    const vitest = findPackageJSON('vitest', pathToFileURL(path.join(path.resolve(root), 'package.json')));
    // From Vitest's real location: pnpm links it into the project and keeps its dependencies next to the target.
    const vite = vitest ? findPackageJSON('vite', pathToFileURL(realpathSync(vitest))) : undefined;

    if (!vite) return null;
    const manifest = JSON.parse(readFileSync(vite, 'utf8')) as {
      exports?: unknown;
      module?: unknown;
    };
    const entry =
      esmEntry((manifest.exports as Record<string, unknown> | undefined)?.['.']) ?? manifest.module;

    return typeof entry === 'string' ? pathToFileURL(path.resolve(path.dirname(vite), entry)).href : null;
  } catch {
    // Not installed, or a package.json that cannot be read: the caller falls back to the Vitest root.
    return null;
  }
}

/** The file an `exports` entry gives to `import`: `"./x.js"`, `{ import: "./x.js" }` or `{ import: { default } }`. */
function esmEntry(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;

  if (!entry || typeof entry !== 'object') return undefined;
  const conditions = entry as Record<string, unknown>;

  return esmEntry(conditions.import) ?? esmEntry(conditions.default);
}

/** The directory of the `@mizchi/mutator-vitest` package that a mutator CLI loads, or null. */
export function mutatorVitestDir(mutatorBin: string): string | null {
  try {
    const manifest = findPackageJSON('@mizchi/mutator-vitest', pathToFileURL(realpathSync(mutatorBin)));

    // Vite compares real paths, and pnpm links the package from its store.
    return manifest ? realpathSync(path.dirname(manifest)) : null;
  } catch {
    // Not resolvable from the CLI: nothing to allow, and the run reports what fails.
    return null;
  }
}
