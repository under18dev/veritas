import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { MutationRuntimeOptions } from './mutation-runtime.js';

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

/** The modules of the project's own Vitest toolchain that the generated config uses; null where not found. */
export interface VitestToolchain {
  /** `file:` URL of the project's Vite, which loads the configs of file projects. */
  viteUrl: string | null;
  /** `file:` URL of the picomatch Vitest matches test globs with. */
  picomatchUrl: string | null;
  /** `file:` URL of the tinyglobby Vitest resolves project globs with. */
  tinyglobbyUrl: string | null;
  /** Major version of the project's Vitest. */
  vitestMajor: number | null;
}

/**
 * Write a Vitest config for one mutation run that is the project's own, changed in two ways only:
 * - with `testFiles` (POSIX, relative to `root`), limited to those tests. mutator runs its baseline and every mutant
 *   with the tests this config selects, and it has no other way to choose tests. Each project keeps only the files
 *   its include/exclude globs match, matched with the project's own picomatch as Vitest matches them, and a project
 *   left with none is not run. Projects given as config files, directories or globs are loaded with the project's
 *   Vite and narrowed the same way. When a project cannot be narrowed, or no project runs any selected file, the
 *   config throws and the run fails with that reason instead of running other tests.
 * - with `fsAllow`, Vite's `server.fs.allow` also lists those directories. The mutator bundled with Veritas has
 *   Vitest load its setup file from outside the project, which Vite (before 8) refuses: every test then fails
 *   with "Cannot find module '/@fs/…'". Vite's default (the workspace root) is kept, and `strict` is left alone.
 */
export function writeMutationVitestConfig(options: {
  root: string;
  dir: string;
  testFiles?: string[];
  fsAllow?: FsAllow;
  toolchain?: VitestToolchain;
}): string {
  const root = path.resolve(options.root);
  const base = findVitestConfig(root);
  const file = path.join(options.dir, 'vitest.mutation.config.mjs');
  const toolchain = options.toolchain ?? vitestToolchain(root);
  const runtime: MutationRuntimeOptions = {
    configDir: root,
    configFile: base,
    files: options.testFiles?.map((test) => path.join(root, test)) ?? null,
    allowDirs: options.fsAllow?.dirs ?? [],
    viteUrl: options.fsAllow?.viteUrl ?? toolchain.viteUrl,
    picomatchUrl: toolchain.picomatchUrl,
    tinyglobbyUrl: toolchain.tinyglobbyUrl,
    vitestMajor: toolchain.vitestMajor,
  };
  const lines = [
    '// Written by Veritas for one mutation run: the project Vitest config, limited to the tests that',
    '// import the mutated code and allowing the files of the mutator that runs them. Safe to delete.',
    `import { mutationConfig } from ${JSON.stringify(new URL(`./mutation-runtime${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url).href)};`,
    base
      ? `import * as baseModule from ${JSON.stringify(pathToFileURL(base).href)};`
      : 'const baseModule = {};',
    `const options = ${JSON.stringify(runtime, null, 2)};`,
    'export default (env) => mutationConfig(baseModule, env, options);',
    '',
  ];
  writeFileSync(file, lines.join('\n'));

  return file;
}

/** The modules of the project's Vitest that the generated config needs, found without running Vitest. */
export function vitestToolchain(root: string): VitestToolchain {
  const vitest = packageOf('vitest', path.join(path.resolve(root), 'package.json'));
  // From Vitest's real location: pnpm links it into the project and keeps its dependencies next to the target.
  const fromVitest = (name: string) => (vitest ? entryUrl(packageOf(name, vitest)) : null);
  let vitestMajor: number | null = null;

  try {
    if (vitest) {
      const version = (JSON.parse(readFileSync(vitest, 'utf8')) as { version?: unknown }).version;
      const major = typeof version === 'string' ? Number.parseInt(version, 10) : Number.NaN;
      vitestMajor = Number.isInteger(major) ? major : null;
    }
  } catch {
    // An unreadable package.json: the version stays unknown.
  }

  return {
    viteUrl: projectViteUrl(root),
    picomatchUrl: fromVitest('picomatch'),
    tinyglobbyUrl: fromVitest('tinyglobby'),
    vitestMajor,
  };
}

/** The real path of the package.json of `name` as resolved from `from`, or null. */
function packageOf(name: string, from: string): string | null {
  try {
    const found = findPackageJSON(name, pathToFileURL(from));

    return found ? realpathSync(found) : null;
  } catch {
    // Not installed, or a package.json that cannot be read.
    return null;
  }
}

/** `file:` URL of the ES module (or, failing that, main) entry of the package whose package.json this is. */
function entryUrl(manifestPath: string | null): string | null {
  if (!manifestPath) return null;

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      exports?: unknown;
      module?: unknown;
      main?: unknown;
    };
    const exported = manifest.exports;
    const dot =
      typeof exported === 'string' ? exported : (exported as Record<string, unknown> | undefined)?.['.'];
    const entry = esmEntry(dot) ?? manifest.module ?? manifest.main ?? 'index.js';

    return typeof entry === 'string'
      ? pathToFileURL(path.resolve(path.dirname(manifestPath), entry)).href
      : null;
  } catch {
    // An unreadable package.json: the caller goes without the module.
    return null;
  }
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
