import { existsSync, writeFileSync } from 'node:fs';
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

/**
 * Write a Vitest config that is the project's own, limited to `testFiles` (POSIX, relative to `root`).
 * mutator runs its baseline and every mutant with the tests this config selects, and it has no other way
 * to choose tests. Inline `test.projects` keep only the files their include/exclude globs match; projects
 * defined in other files cannot be narrowed and are kept as they are.
 */
export function writeNarrowedVitestConfig(options: {
  root: string;
  dir: string;
  testFiles: string[];
}): string {
  const root = path.resolve(options.root);
  const base = findVitestConfig(root);
  const file = path.join(options.dir, 'vitest.mutation.config.mjs');
  const absolute = options.testFiles.map((test) => path.join(root, test));
  const lines = [
    '// Written by Veritas for one mutation run: the project Vitest config, limited to the tests that',
    '// import the mutated code. Safe to delete.',
    "import path from 'node:path';",
    base
      ? `import * as baseModule from ${JSON.stringify(pathToFileURL(base).href)};`
      : 'const baseModule = {};',
    `const configDir = ${JSON.stringify(root)};`,
    `const files = ${JSON.stringify(absolute)};`,
    'const matches = (relative, globs) => globs.some((glob) => path.posix.matchesGlob(relative, glob));',
    'const select = (test, vitestRoot) => {',
    "  const relative = files.map((f) => path.relative(vitestRoot, f).split(path.sep).join('/'));",
    '  return relative.filter(',
    '    (f) => (!test?.include || matches(f, test.include)) && !(test?.exclude && matches(f, test.exclude)),',
    '  );',
    '};',
    'export default async (env) => {',
    '  let base = baseModule.default ?? {};',
    "  if (typeof base === 'function') base = await base(env);",
    '  base = (await base) ?? {};',
    '  const vitestRoot = base.root ? path.resolve(configDir, base.root) : configDir;',
    '  const test = base.test ?? {};',
    '  if (!Array.isArray(test.projects))',
    '    return { ...base, root: vitestRoot, test: { ...test, include: select(test, vitestRoot) } };',
    '  const projects = [];',
    '  for (const entry of test.projects) {',
    "    if (!entry || typeof entry !== 'object') {",
    '      projects.push(entry);',
    '      continue;',
    '    }',
    '    const projectRoot = entry.root ? path.resolve(vitestRoot, entry.root) : vitestRoot;',
    '    const include = select(entry.test, projectRoot);',
    '    if (include.length > 0) projects.push({ ...entry, test: { ...entry.test, include } });',
    '  }',
    '  return { ...base, root: vitestRoot, test: { ...test, projects } };',
    '};',
    '',
  ];
  writeFileSync(file, lines.join('\n'));
  return file;
}
