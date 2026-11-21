import type { TestFramework } from './config/schema.js';
import { VeritasError } from './exit-codes.js';
import type { TestCase } from './schema/tests.js';

/**
 * What Veritas needs to know about a test runner, kept behind one interface so the rest of the pipeline stays
 * runner-neutral. Each runner has its own provider package under `packages/test-runners/<runner>`; `core` only
 * holds the interface, and whoever depends on the providers (the engine) selects one with `selectTestRunner`, or
 * finds the one a project uses with `chooseTestRunner`.
 *
 * The parts static analysis uses are plain data (module and API names), not callbacks into a syntax tree, so the
 * analysers stay generic and a provider has no dependency on the TypeScript compiler.
 */
export interface TestRunnerProvider {
  /** The `analysis.testFramework` value that selects this provider; also the name of its doctor capability. */
  readonly name: TestFramework;
  /** The runner's name as people write it, for messages ("Vitest"). */
  readonly displayName: string;
  /**
   * What the runner puts between the titles of the enclosing suites and the test's own title in a test's full name,
   * as its reports and mutator's test ids give it (` > ` for Vitest, a space for Jest).
   */
  readonly fullNameSeparator: string;
  readonly detection: TestRunnerDetection;
  /** The runner's test API as it works in most projects; `recognitionFor` adapts it to one project. */
  readonly recognition: TestRunnerRecognition;
  /**
   * The test API as it works in the project at `root`, read without running anything (for Jest, what `jest.mock`
   * does depends on whether the tests run as native ES modules).
   */
  recognitionFor(root: string): TestRunnerRecognition;
  readonly execution: TestRunnerExecution;
  readonly mutation: TestRunnerMutation;
  /** Syntax of generated test files for the project at `root`, whose installed packages can change the imports. */
  templates(root: string): TestRunnerTemplates;
}

/** A parsed package.json; detection reads only some of its fields. */
export type PackageJson = Record<string, unknown>;

/** How `detect`, `doctor` and `init` find the runner in a project, without running any of its code. */
export interface TestRunnerDetection {
  /** The npm package of the runner, looked up in package.json (declared) and in `node_modules` (installed). */
  readonly packageName: string;
  /** How the project at `root` has the runner; `packageJson` is its parsed package.json, or null without one. */
  detect(root: string, packageJson: PackageJson | null): TestRunnerInstallation;
}

/** What detection finds about one runner in one project, as `detectProject` reports it. */
export interface TestRunnerInstallation {
  readonly name: TestFramework;
  /** Declared in the dependencies or devDependencies of package.json. */
  readonly declared: boolean;
  /** Version installed for the project root, or null. */
  readonly installedVersion: string | null;
  /** The runner's config file at the root (relative to it), or null. */
  readonly configFile: string | null;
  /** The `test` script of package.json runs the runner. */
  readonly testScript: boolean;
  /**
   * What shows that the project uses the runner, strongest first (`jest.config.mjs`, `the test script runs jest`);
   * empty when nothing does. Being installed is not listed: another dependency may have brought the package in.
   */
  readonly evidence: readonly string[];
  /** One sentence saying what was found, or that nothing was, for people. */
  readonly reason: string;
}

export type TestModifier = TestCase['modifiers'][number];

/**
 * What a call to the runner's mock API does, by the API's name on the mock object (`vi.fn` creates a mock):
 * - `create`: a new mock function (`vi.fn()`);
 * - `spy`: a spy on a member of an object or module (`vi.spyOn(object, 'name')`);
 * - `wrap`: the same function typed as a mock (`vi.mocked(fn)`), which replaces the project symbol it is given;
 * - `module_hoisted`: replaces a module for the whole file wherever it is written (`vi.mock`, hoisted by Vitest);
 * - `module`: replaces a module from where it is called (`vi.doMock`);
 * - `module_access`: loads or restores a module by its specifier without replacing it (`vi.importActual`);
 * - `module_late`: replaces a module only for code that loads it after the call (a later `require` or dynamic
 *   `import()`), never for the file's static imports, which are bound before any of its code runs (`jest.mock` in a
 *   native ES module); it is not recorded as a mock of the code the file imports;
 * - `stub_global`: replaces a global (`vi.stubGlobal`).
 */
export type MockCallRole =
  | 'create'
  | 'spy'
  | 'wrap'
  | 'module_hoisted'
  | 'module'
  | 'module_access'
  | 'module_late'
  | 'stub_global';

/**
 * The runner's test API as names, for the static test inventory. A name counts when it is imported from one of
 * `modules` (under any local alias) or used as a global the project's type declarations provide.
 */
export interface TestRunnerRecognition {
  /**
   * Modules exporting the test API (`vitest`, `@jest/globals`). A file importing one of them by name is a test file
   * candidate. Runners that also provide the API as globals (Jest) need no import; the names below count either way.
   */
  readonly modules: readonly string[];
  /** The runner provides its test API as globals by default (Jest does; Vitest only with its `globals` option). */
  readonly globals: boolean;
  /** Functions registering one test (`it`, `test`), including those of `shorthands`. */
  readonly tests: readonly string[];
  /** Functions registering a suite (`describe`), including those of `shorthands`. */
  readonly suites: readonly string[];
  /** Members chained on a registration function that are recorded as modifiers (`it.skip`, `describe.only`). */
  readonly modifiers: readonly TestModifier[];
  /**
   * Members chained on a test registration that invert its outcome, so the test passes only when it fails (Vitest's
   * `it.fails`, Jest's `it.failing`); recorded as the `expected_failure` modifier.
   */
  readonly expectedFailure: readonly string[];
  /** Registration functions that carry a modifier in their name (Jest's `xit` skips, `fdescribe` focuses). */
  readonly shorthands: Readonly<Record<string, TestModifier>>;
  /** Members returning a registration function instead of registering (`it.each(table)`, `test.skipIf(cond)`). */
  readonly registrationFactories: readonly string[];
  /** Those of `registrationFactories` that register one test per row of a table, recorded as `each`. */
  readonly tableFactories: readonly string[];
  /** Hook functions, by when they run. */
  readonly hooks: {
    readonly beforeEach: readonly string[];
    readonly beforeAll: readonly string[];
    readonly afterEach: readonly string[];
    readonly afterAll: readonly string[];
  };
  /**
   * Value exports of `modules` that only work inside a test run (assertions, the mock API): a file importing one of
   * them, or the whole module as a namespace, is test code wherever it lives. Type imports never count.
   */
  readonly runtimeExports: readonly string[];
  readonly assertions: {
    /** Functions starting an assertion chain (`expect(value)`). */
    readonly expect: readonly string[];
    /** Assertions on TypeScript types, which do nothing when the test runs (`expectTypeOf`, `assertType`). */
    readonly typeLevel: readonly string[];
    /**
     * Objects whose methods assert (`assert.equal(a, b)`), by the name they are used under: chai's `assert` that
     * Vitest exports, and `node:assert` imported as `assert`.
     */
    readonly objects: readonly string[];
    /** Methods, on any object, that check how many assertions ran (`expect.assertions(1)`). */
    readonly counts: readonly string[];
  };
  readonly mocks: {
    /** Objects holding the mock API (`vi`), imported from `modules` or provided as an ambient global. */
    readonly objects: readonly string[];
    /** Mock API members by what calling them does; members not listed are not mock calls. */
    readonly calls: Readonly<Record<string, MockCallRole>>;
    /** Methods configuring an existing mock (`spy.mockReturnValue(1)`), as a regular expression source. */
    readonly configureMethod: string;
  };
}

export type TestRunStatus = 'passed' | 'failed' | 'skipped';

/** The structured result of one run of a project's tests. */
export type TestRunResult =
  | {
      status: 'ok';
      /** `<relative file>::<full test name>` -> status. A file that fails to load is `<file>::(file)`. */
      tests: Map<string, TestRunStatus>;
      failures: string[];
      passed: number;
      failed: number;
    }
  | { status: 'error'; detail: string };

export interface TestRunOptions {
  timeoutMs: number;
  /** Names the run's own files (its report), so two runs in one directory do not overwrite each other. */
  label: string;
  /** Test files relative to `cwd` (POSIX) to run; all of the project's tests when absent. */
  files?: string[];
  signal?: AbortSignal;
}

/** Running the project's own tests (improvement baseline and patched runs). */
export interface TestRunnerExecution {
  /** How a run is shown to people, for example in the commands of an improvement plan (`vitest run`). */
  readonly command: string;
  /** Run the project's own runner once in `cwd`, without a shell, and read its machine-readable report. */
  run(cwd: string, options: TestRunOptions): Promise<TestRunResult>;
}

/** What mutation testing with `@mizchi/mutator` needs from the runner. */
export interface TestRunnerMutation {
  /** The runner mutator drives the tests with (its `--runner`), or null when mutator cannot drive this runner. */
  readonly mutatorRunner: string | null;
  /** Runner major versions before this fail in mutator's integration before any mutant is tried; null if none do. */
  readonly minMajor: number | null;
  /** The runner major version mutator declares; older ones that are not below `minMajor` work with a warning. */
  readonly declaredMajor: number | null;
  /**
   * Why mutator's support for this runner is experimental, said as a warning wherever mutation is checked or run;
   * null when it is not.
   */
  readonly experimental: string | null;
  /** The mutator option that passes the config `writeConfig` writes (`--config`, `--jest-config`). */
  readonly configFlag: string;
  /**
   * Why mutator cannot run the tests of the project at `root` with this runner, found without running anything
   * (a project kind its integration does not handle); null when nothing stands in the way.
   */
  unsupportedReason(root: string): string | null;
  /**
   * Directories outside the project that the runner has to load files from when mutator is the copy bundled with
   * Veritas (at `mutatorBin`) rather than the project's own; empty when none have to be allowed.
   */
  bundledMutatorDirs(mutatorBin: string): string[];
  /**
   * Write a runner config for one mutation run into `dir` and return its path (passed with `configFlag`): the
   * project's own config, limited to `testFiles` (POSIX, relative to the root) when given, and allowed to load files
   * from `allowDirs`.
   */
  writeConfig(options: { root: string; dir: string; testFiles?: string[]; allowDirs: string[] }): string;
}

/** Parts of the runner's test API a generated test file uses. */
export type TemplateApi = 'describe' | 'it' | 'expect';

/** Syntax of generated test files (`test generate`, `improve`). */
export interface TestRunnerTemplates {
  /** Import statements that make `names` available, in a stable order; none when the runner provides globals. */
  imports(names: readonly TemplateApi[]): string[];
  /** A statement asserting that `actual` is strictly equal to `expected` (both are expressions). */
  expectToBe(actual: string, expected: string): string;
}

/** The provider for a configured test framework among the available ones. */
export function selectTestRunner(
  providers: readonly TestRunnerProvider[],
  framework: TestFramework,
): TestRunnerProvider {
  const provider = providers.find((candidate) => candidate.name === framework);

  if (!provider) {
    throw new VeritasError(
      'user',
      'UNSUPPORTED_TEST_FRAMEWORK',
      `no test runner provider for analysis.testFramework "${framework}"`,
      `supported: ${providers.map((candidate) => candidate.name).join(', ') || 'none'}`,
    );
  }

  return provider;
}

/** A test's full name as the runner writes it in reports: the suite titles and the test title, joined. */
export function testFullName(
  runner: Pick<TestRunnerProvider, 'fullNameSeparator'>,
  suitePath: readonly string[],
  name: string,
): string {
  return [...suitePath, name].join(runner.fullNameSeparator);
}

/** The major version of a version string (`5.1.1` is 5), or null. */
export function majorVersion(version: string | null): number | null {
  const major = version ? Number.parseInt(version, 10) : Number.NaN;

  return Number.isNaN(major) ? null : major;
}
