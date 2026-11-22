/**
 * Runs inside the project's Vitest, loaded by the config `writeMutationVitestConfig` writes: it turns the project's
 * own config into one that runs only the selected test files. It imports nothing but Node built-ins at load time;
 * the matcher, globber and config loader come from the project's own Vitest and Vite, by the URLs it is given.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/** What the generated config passes in. Paths are absolute. */
export interface MutationRuntimeOptions {
  /** Directory of the project config: the project root. */
  configDir: string;
  /** The project config file itself, or null when the project has none. */
  configFile: string | null;
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
type Selection = { include: string[]; includeSource: string[] };
type Env = { mode?: string } | undefined;

interface Tinyglobby {
  glob: (patterns: string[], options: object) => Promise<string[]>;
  isDynamicPattern: (pattern: string) => boolean;
}

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

function noneSelected(count: number, where: string): Error {
  return new Error(
    `Veritas selected ${count} test file(s) for mutation, and the project's Vitest config runs none of them: ${where} match none of them. Mutation testing was not run, since every mutant would be reported as not covered.`,
  );
}

const posix = (file: string) => file.split(path.sep).join('/');

const toArray = (value: unknown): string[] | undefined =>
  value === undefined ? undefined : Array.isArray(value) ? (value as string[]) : [value as string];

/** Concatenates inherited and own values, as Vite's `mergeConfig` does for arrays. */
const inherit = (inherited: string[] | undefined, own: string[] | undefined): string[] | undefined =>
  inherited === undefined && own === undefined ? undefined : [...(inherited ?? []), ...(own ?? [])];

/** Picomatch and tinyglobby are dependencies of Vitest 4 and later: without them, nothing can be matched as Vitest does. */
async function loadModule<T>(url: string | null, name: string): Promise<T> {
  if (url) {
    try {
      const mod = (await import(url)) as { default?: unknown };

      return (name === 'picomatch' ? (mod.default ?? mod) : mod) as T;
    } catch {
      // Reported below.
    }
  }

  throw cannotNarrow(
    'config',
    `the ${name} of the project's Vitest, which Vitest matches test files with, could not be loaded`,
  );
}

/** A glob relative to `dir`, the way tinyglobby takes it: without a leading `./`, and absolute ones made relative. */
function relativeGlob(glob: string, dir: string): string {
  if (path.isAbsolute(glob)) return posix(path.relative(dir, glob));

  return glob.startsWith('./') ? glob.slice(2) : glob;
}

/** Splits patterns as tinyglobby does: those starting with `!` exclude what the others include. */
function splitNegated(patterns: string[]): { positive: string[]; negative: string[] } {
  return {
    positive: patterns.filter((p) => !p.startsWith('!')),
    negative: patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1)),
  };
}

/**
 * The paths the string `projects` entries stand for, resolved as Vitest resolves them: config files, and directories
 * ending with `/`. Plain paths come first, each as written; glob patterns are expanded together, so that a negated
 * one (`!packages/excluded`) leaves out what the others match.
 */
async function projectPaths(
  entries: string[],
  root: string,
  tinyglobby: Tinyglobby,
): Promise<{ path: string; entry: string }[]> {
  const found: { path: string; entry: string }[] = [];
  const patterns: string[] = [];

  for (const entry of entries) {
    // Vitest substitutes its own root, which Vite keeps in POSIX form.
    const pattern = entry.replace('<rootDir>', posix(root));

    if (tinyglobby.isDynamicPattern(pattern)) {
      patterns.push(pattern);
      continue;
    }
    const file = path.resolve(root, pattern);
    const isDir = existsSync(file) && statSync(file).isDirectory();
    found.push({ entry, path: isDir ? `${file.replace(/[/\\]$/, '')}/` : file });
  }

  if (patterns.length > 0) {
    const matched = await tinyglobby.glob(patterns, {
      absolute: true,
      dot: true,
      onlyFiles: false,
      cwd: root,
      expandDirectories: false,
      ignore: ['**/node_modules/**', '**/*.timestamp-*', '**/.DS_Store'],
    });

    for (const match of matched) found.push({ entry: patterns.join(', '), path: match });
  }

  return found;
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

const samePath = (a: string, b: string) => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
};

/** The root of a config, as Vitest resolves it: `test.root`, else `root`, against `dir`. */
const rootOf = (config: Config, dir: string) => {
  const custom = config.test?.root ?? config.root;

  return custom ? path.resolve(dir, custom) : dir;
};

/** Turn the project config into the config of one mutation run. */
export async function mutationConfig(
  baseModule: { default?: unknown },
  env: Env,
  options: MutationRuntimeOptions,
): Promise<Config> {
  let base: unknown = baseModule.default ?? {};

  if (typeof base === 'function') base = await (base as (env: Env) => unknown)(env);
  const config = ((await base) ?? {}) as Config;
  const vitestRoot = rootOf(config, options.configDir);
  const allowed = (resolved: Config) => allowing(resolved, vitestRoot, options);
  const { root: _ownTestRoot, ...test }: TestOptions = config.test ?? {};

  if (options.files === null) return allowed({ ...config, root: vitestRoot, test });
  const files = options.files;
  const picomatch = await loadModule<(globs: string[], options: object) => Matcher>(
    options.picomatchUrl,
    'picomatch',
  );
  // Vitest finds test files with tinyglobby, which matches with picomatch and `dot: true`.
  const glob = (globs: string[]): Matcher =>
    globs.length === 0 ? () => false : picomatch(globs, { dot: true });
  const mode = env?.mode ?? 'test';
  /**
   * The selected files a project with these options runs, as globs relative to its test directory: those its include
   * selects, and the in-source candidates its includeSource selects. Those stay in includeSource, where Vitest still
   * runs only the ones that contain `import.meta.vitest`.
   */
  const select = (t: TestOptions, root: string, inherited: TestOptions = {}): Selection => {
    const dir = path.resolve(root, t.dir ?? inherited.dir ?? '.');
    const patterns = splitNegated(inherit(toArray(inherited.include), toArray(t.include)) ?? DEFAULT_INCLUDE);
    const source = splitNegated(inherit(toArray(inherited.includeSource), toArray(t.includeSource)) ?? []);
    const exclude = inherit(toArray(inherited.exclude), toArray(t.exclude)) ?? DEFAULT_EXCLUDE;
    const matches = (globs: string[]) => glob(globs.map((g) => relativeGlob(g, dir)));
    const included = matches(patterns.positive);
    const inSource = matches(source.positive);
    const excluded = matches([...exclude, ...patterns.negative]);
    const excludedFromSource = matches([...exclude, ...source.negative]);

    const relative = files.map((f) => posix(path.relative(dir, f)));
    const include = relative.filter((f) => included(f) && !excluded(f));
    const includeSource = relative.filter(
      (f) => !include.includes(f) && inSource(f) && !excludedFromSource(f),
    );

    return { include, includeSource };
  };
  const any = (selection: Selection) => selection.include.length + selection.includeSource.length > 0;

  if (!Array.isArray(test.projects)) {
    const selection = select(test, vitestRoot);

    if (!any(selection)) throw noneSelected(files.length, 'its include and exclude patterns');

    return allowed({ ...config, root: vitestRoot, test: { ...test, ...selection } });
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
  const strings = test.projects.filter((definition): definition is string => typeof definition === 'string');

  for (const definition of test.projects) {
    if (typeof definition === 'string') continue;
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
    const projectRoot = rootOf(entry, vitestRoot);
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
    const selection = select(entryTest, projectRoot, inherited);

    if (any(selection)) projects.push({ ...entry, test: { ...entryTest, ...selection } });
  }

  if (strings.length > 0) {
    const tinyglobby = await loadModule<Tinyglobby>(options.tinyglobbyUrl, 'tinyglobby');
    /** Config files and directories already turned into a project: Vitest resolves each once. */
    const seen = new Set<string>();

    const resolvedPaths = await projectPaths(strings, vitestRoot, tinyglobby);
    const globbed = new Set(resolvedPaths.filter((p) => !strings.includes(p.entry)).map((p) => p.entry));

    for (const { path: found, entry } of resolvedPaths) {
      const isDir = found.endsWith('/');
      const configFile = !existsSync(found)
        ? found
        : isDir
          ? (DIRECTORY_CONFIGS.find((name) => readdirSync(found).includes(name)) ?? null)
          : found;
      const file = isDir && configFile ? path.join(found, configFile) : configFile;

      if (!existsSync(found) || (file && !CONFIG_NAME.test(path.basename(file)))) {
        // Vitest stops when a glob matches a file that is not a config. The globs were expanded together, so their
        // joined text matches nothing and Vitest would skip it silently: stop here instead.
        if (globbed.has(entry))
          throw cannotNarrow(
            'projects',
            `the projects glob ${entry} matched ${posix(path.relative(vitestRoot, found))}, which is not a Vitest config file`,
          );
        // Vitest itself refuses this entry; keep it so that Vitest says why.
        if (!projects.includes(entry)) projects.push(entry);
        continue;
      }
      const key = file ?? found;

      if (seen.has(key)) continue;
      seen.add(key);

      if (file && options.configFile && samePath(file, options.configFile)) {
        // Vitest runs the declaring config itself as one of its projects, with its own test options.
        const selection = select(test, vitestRoot);

        if (any(selection)) {
          // Vitest runs the root's globalSetup once for the whole run, not again for this project.
          const { projects: _projects, globalSetup: _globalSetup, ...own } = test;
          projects.push({
            ...config,
            root: vitestRoot,
            extends: false,
            test: { ...own, name: own.name ?? fileProjectName(file), ...selection },
          });
        }
        continue;
      }
      const dir = isDir ? found.slice(0, -1) : path.dirname(found);
      const own = file ? await loadFile(file) : {};
      const { root: _testRoot, ...ownTest }: TestOptions = own.test ?? {};

      if (Array.isArray(ownTest.projects))
        throw cannotNarrow(`project ${file}`, 'it declares projects of its own');
      // Its own root and test.root count from its directory, as Vitest resolves them; an absolute one stays.
      const projectRoot = rootOf(own, dir);
      const selection = select(ownTest, projectRoot);

      if (!any(selection)) continue;
      // A file project owns all of its values, so the inline copy inherits nothing.
      projects.push({
        ...own,
        root: projectRoot,
        extends: false,
        test: { ...ownTest, name: ownTest.name ?? fileProjectName(file ?? found), ...selection },
      });
    }
  }

  if (projects.length === 0)
    throw noneSelected(files.length, 'the include and exclude patterns of its projects');
  // Projects that extend this config would add its include to their own narrowed one.
  const { include: _include, includeSource: _source, ...rootTest } = test;

  return allowed({ ...config, root: vitestRoot, test: { ...rootTest, projects } });
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
