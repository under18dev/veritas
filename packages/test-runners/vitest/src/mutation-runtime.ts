/**
 * Runs inside the project's Vitest, loaded by the config `writeMutationVitestConfig` writes: it turns the project's
 * own config into one that runs only the selected test files. It imports nothing but Node built-ins at load time;
 * the matcher, globber and config loader come from the project's own Vitest and Vite, by the URLs it is given.
 */
import { existsSync, globSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** What the generated config passes in. Paths are absolute. */
export interface MutationRuntimeOptions {
  /** Directory of the project config: the project root. */
  configDir: string;
  /** Absolute test files to run, or null to keep the config's own selection. */
  files: string[] | null;
  /** Directories Vite must also allow files from. */
  allowDirs: string[];
  /** `file:` URL of the project's Vite, or null. */
  viteUrl: string | null;
  /** `file:` URL of the picomatch the project's Vitest matches test globs with, or null. */
  picomatchUrl: string | null;
  /** `file:` URL of the tinyglobby the project's Vitest resolves project globs with, or null. */
  tinyglobbyUrl: string | null;
  /** Major version of the project's Vitest, or null when unknown. */
  vitestMajor: number | null;
}

type Config = Record<string, unknown> & { test?: TestOptions; root?: string; extends?: unknown };
type TestOptions = Record<string, unknown> & {
  include?: string[];
  exclude?: string[];
  includeSource?: string[];
  dir?: string;
  root?: string;
  name?: unknown;
  projects?: unknown[];
};
type Matcher = (relative: string) => boolean;
type Env = { mode?: string } | undefined;

/** Vitest's defaults (4 and later) for a config that sets no `include` or `exclude`. */
const DEFAULT_INCLUDE = ['**/*.{test,spec}.?(c|m)[jt]s?(x)'];
const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/.git/**'];
/** The config files Vitest looks for in a project directory, in its order. */
const DIRECTORY_CONFIGS = ['vitest', 'vite'].flatMap((base) =>
  ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].map((ext) => `${base}.config.${ext}`),
);
const CONFIG_NAME = /^vite(?:st)?(?:\.[\w-]+)?\.config\./;

/** Thrown when a project cannot be limited to the selected tests; the run stops with this message. */
function cannotNarrow(what: string, why: string): Error {
  return new Error(
    `Veritas cannot limit the Vitest ${what} to the test files selected for mutation: ${why}. Mutation testing was not run rather than run tests that were not selected.`,
  );
}

const posix = (file: string) => file.split(path.sep).join('/');

const toArray = (value: unknown): string[] | undefined =>
  value === undefined ? undefined : Array.isArray(value) ? (value as string[]) : [value as string];

/** Concatenates inherited and own values, as Vite's `mergeConfig` does for arrays. */
const inherit = (inherited: string[] | undefined, own: string[] | undefined): string[] | undefined =>
  inherited === undefined && own === undefined ? undefined : [...(inherited ?? []), ...(own ?? [])];

async function loadMatcher(picomatchUrl: string | null): Promise<(globs: string[]) => Matcher> {
  if (picomatchUrl) {
    try {
      const mod = (await import(picomatchUrl)) as { default?: unknown };
      const picomatch = (mod.default ?? mod) as (globs: string[], options: object) => Matcher;

      // Vitest finds test files with tinyglobby, which matches with picomatch and `dot: true`.
      return (globs) => (globs.length === 0 ? () => false : picomatch(globs, { dot: true }));
    } catch {
      // Fall back to Node's matcher below.
    }
  }

  // No extglob support: a file only such a pattern selects is not run, and the run reports that no test ran.
  return (globs) => (relative) => globs.some((glob) => path.posix.matchesGlob(relative, glob));
}

/** A glob relative to `dir`, the way tinyglobby takes it: without a leading `./`, and absolute ones made relative. */
function relativeGlob(glob: string, dir: string): string {
  if (path.isAbsolute(glob)) return posix(path.relative(dir, glob));

  return glob.startsWith('./') ? glob.slice(2) : glob;
}

interface Tinyglobby {
  glob: (patterns: string[], options: object) => Promise<string[]>;
  isDynamicPattern: (pattern: string) => boolean;
}

/** Resolved paths a string `projects` entry stands for: config files, and directories ending with `/`. */
async function projectPaths(entry: string, root: string, tinyglobbyUrl: string | null): Promise<string[]> {
  const pattern = entry.replace('<rootDir>', root);
  let glob: Tinyglobby | null = null;

  if (tinyglobbyUrl) {
    try {
      glob = (await import(tinyglobbyUrl)) as Tinyglobby;
    } catch {
      // Fall back to Node's glob below.
    }
  }
  const dynamic = glob ? glob.isDynamicPattern(pattern) : /[*?[\]{}()!]/.test(pattern);

  if (!dynamic) {
    const file = path.resolve(root, pattern);

    if (!existsSync(file)) return [file];

    return [statSync(file).isDirectory() ? `${file.replace(/[/\\]$/, '')}/` : file];
  }
  const ignore = ['**/node_modules/**', '**/*.timestamp-*', '**/.DS_Store'];

  if (glob)
    return glob.glob([pattern], {
      absolute: true,
      dot: true,
      onlyFiles: false,
      cwd: root,
      expandDirectories: false,
      ignore,
    });

  return globSync(pattern, { cwd: root, withFileTypes: true, exclude: (d) => d.name === 'node_modules' }).map(
    (d) => {
      const full = path.join(d.parentPath, d.name);

      return d.isDirectory() ? `${full}/` : full;
    },
  );
}

/** The name Vitest gives a file or directory project that does not name itself. */
function fileProjectName(projectPath: string): string {
  const dir = projectPath.endsWith('/') ? projectPath.slice(0, -1) : path.dirname(projectPath);

  try {
    const name = (JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown })
      .name;

    if (typeof name === 'string' && name) return name;
  } catch {}

  return path.basename(dir);
}

/** Turn the project config into the config of one mutation run. */
export async function mutationConfig(
  baseModule: { default?: unknown },
  env: Env,
  options: MutationRuntimeOptions,
): Promise<Config> {
  let base: unknown = baseModule.default ?? {};

  if (typeof base === 'function') base = await (base as (env: Env) => unknown)(env);
  const config = ((await base) ?? {}) as Config;
  const vitestRoot = config.root ? path.resolve(options.configDir, config.root) : options.configDir;
  const allowed = (resolved: Config) => allowing(resolved, vitestRoot, options);
  const test: TestOptions = config.test ?? {};

  if (options.files === null) return allowed({ ...config, root: vitestRoot });
  const files = options.files;
  const glob = await loadMatcher(options.picomatchUrl);
  const mode = env?.mode ?? 'test';
  /** The selected files a project with these options runs, as include globs relative to its test directory. */
  const select = (t: TestOptions, root: string, inherited: TestOptions = {}): string[] => {
    const dir = path.resolve(root, t.dir ?? inherited.dir ?? '.');
    const include = inherit(toArray(inherited.include), toArray(t.include)) ?? DEFAULT_INCLUDE;
    const exclude = inherit(toArray(inherited.exclude), toArray(t.exclude)) ?? DEFAULT_EXCLUDE;
    const source = inherit(toArray(inherited.includeSource), toArray(t.includeSource)) ?? [];
    const matches = (globs: string[]) => glob(globs.map((g) => relativeGlob(g, dir)));
    const included = matches(include);
    const excluded = matches(exclude);
    const inSource = matches(source);

    return files
      .map((f) => posix(path.relative(dir, f)))
      .filter((f) => (included(f) || inSource(f)) && !excluded(f));
  };

  if (!Array.isArray(test.projects)) {
    const include = select(test, vitestRoot);

    if (include.length === 0) throw noneSelected(files.length, 'its include and exclude patterns');

    return allowed({ ...config, root: vitestRoot, test: { ...test, include, includeSource: [] } });
  }
  const loadFile = async (file: string): Promise<Config> => {
    if (!options.viteUrl)
      throw cannotNarrow(`project ${file}`, "the project's Vite, which loads its config, was not found");
    const vite = (await import(options.viteUrl)) as {
      loadConfigFromFile: (env: object, file: string, root: string) => Promise<{ config: Config } | null>;
    };
    const loaded = await vite.loadConfigFromFile(
      { command: 'serve', mode, isPreview: false, isSsrBuild: false },
      file,
      path.dirname(file),
    );

    return loaded?.config ?? {};
  };
  const projects: unknown[] = [];

  for (const definition of test.projects) {
    if (typeof definition === 'string') {
      for (const found of await projectPaths(definition, vitestRoot, options.tinyglobbyUrl)) {
        if (!existsSync(found)) {
          // Vitest itself refuses this entry; keep it so that Vitest says why.
          projects.push(definition);
          break;
        }
        const isDir = found.endsWith('/');
        const configFile = isDir
          ? (DIRECTORY_CONFIGS.find((name) => readdirSync(found).includes(name)) ?? null)
          : found;
        const file = isDir && configFile ? path.join(found, configFile) : configFile;

        if (file && !CONFIG_NAME.test(path.basename(file))) {
          // Vitest itself refuses this entry; keep it so that Vitest says why.
          projects.push(definition);
          break;
        }
        const projectRoot = isDir ? found.slice(0, -1) : path.dirname(found);
        const own = file ? await loadFile(file) : {};
        const ownTest: TestOptions = own.test ?? {};

        if (Array.isArray(ownTest.projects))
          throw cannotNarrow(`project ${file}`, 'it declares projects of its own');
        const include = select(ownTest, projectRoot);

        if (include.length === 0) continue;
        const { root: _testRoot, ...rest } = ownTest;
        // A file project owns all of its values, so the inline copy inherits nothing.
        projects.push({
          ...own,
          root: projectRoot,
          extends: false,
          test: {
            ...rest,
            name: ownTest.name ?? fileProjectName(file ?? found),
            include,
            includeSource: [],
          },
        });
      }
      continue;
    }
    const entry = (
      typeof definition === 'function'
        ? await (definition as (env: object) => unknown)({
            command: 'serve',
            mode,
            isPreview: false,
            isSsrBuild: false,
          })
        : await definition
    ) as Config | null;

    if (!entry || typeof entry !== 'object') {
      projects.push(entry);
      continue;
    }
    const entryTest: TestOptions = entry.test ?? {};
    const customRoot = entryTest.root ?? entry.root;
    const projectRoot = customRoot ? path.resolve(vitestRoot, customRoot) : vitestRoot;
    let inherited: TestOptions = {};

    if (typeof entry.extends === 'string') {
      const extended = await loadFile(path.resolve(vitestRoot, entry.extends));
      inherited = extended.test ?? {};

      // Its include would be added to the narrowed one, and running its tests is what this must not do.
      if (inherited.include !== undefined || inherited.includeSource !== undefined)
        throw cannotNarrow(
          `project ${JSON.stringify(entryTest.name ?? entry.extends)}`,
          `the config it extends (${entry.extends}) sets include or includeSource, which Vitest adds to the project's own`,
        );
    } else if (entry.extends === true || (entry.extends === undefined && (options.vitestMajor ?? 5) >= 5)) {
      // Vitest 5 has an inline project extend the config that declares it unless it says otherwise.
      inherited = test;
    }
    const include = select(entryTest, projectRoot, inherited);

    if (include.length > 0) projects.push({ ...entry, test: { ...entryTest, include, includeSource: [] } });
  }

  if (projects.length === 0)
    throw noneSelected(files.length, 'the include and exclude patterns of its projects');
  // Projects that extend this config would add its include to their own narrowed one.
  const { include: _include, includeSource: _source, ...rootTest } = test;

  return allowed({ ...config, root: vitestRoot, test: { ...rootTest, projects } });
}

function noneSelected(count: number, where: string): Error {
  return new Error(
    `Veritas selected ${count} test file(s) for mutation, and the project's Vitest config runs none of them: ${where} match none of them. Mutation testing was not run, since every mutant would be reported as not covered.`,
  );
}

/** Setting `server.fs.allow` replaces Vite's default, the workspace root, so that is listed first. */
async function allowing(
  config: Config,
  vitestRoot: string,
  options: MutationRuntimeOptions,
): Promise<Config> {
  if (options.allowDirs.length === 0) return config;
  const server = (config.server ?? {}) as Record<string, unknown>;
  const fs = (server.fs ?? {}) as Record<string, unknown>;
  let allow = fs.allow as string[] | undefined;

  if (!allow) {
    allow = [vitestRoot];

    try {
      if (options.viteUrl)
        allow = [
          (
            (await import(options.viteUrl)) as { searchForWorkspaceRoot: (root: string) => string }
          ).searchForWorkspaceRoot(vitestRoot),
        ];
    } catch {}
  }

  return { ...config, server: { ...server, fs: { ...fs, allow: [...allow, ...options.allowDirs] } } };
}
