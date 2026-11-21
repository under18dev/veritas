import { detectInstallation, type TemplateApi, type TestRunnerProvider } from '@under18dev/veritas-core';
import { mutatorVitestDir, projectViteUrl, writeMutationVitestConfig } from './mutation-config.js';
import { runVitest } from './run.js';

export {
  findVitestConfig,
  mutatorVitestDir,
  projectViteUrl,
  writeMutationVitestConfig,
} from './mutation-config.js';
export { runVitest } from './run.js';

/**
 * Vitest versions mutation testing works with. @mizchi/mutator declares Vitest 5; Vitest 4 projects run, while on
 * Vitest 3 and earlier its test runner integration fails before any mutant is tried.
 */
export const MUTATOR_MIN_VITEST_MAJOR = 4;
export const MUTATOR_DECLARED_VITEST_MAJOR = 5;

/** The Vitest test runner provider. */
export const vitestTestRunner: TestRunnerProvider = {
  name: 'vitest',
  displayName: 'Vitest',
  fullNameSeparator: ' > ',
  detection: {
    packageName: 'vitest',
    detect: (root, packageJson) =>
      detectInstallation(root, packageJson, {
        name: 'vitest',
        displayName: 'Vitest',
        packageName: 'vitest',
        configFiles: ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vitest.config.mjs'],
        // A Vite config may hold Vitest's settings, but a Vite app tested with another runner has one too.
        sharedConfigFiles: ['vite.config.ts', 'vite.config.js'],
        commands: ['vitest'],
      }),
  },
  recognition: {
    modules: ['vitest'],
    globals: false,
    tests: ['it', 'test'],
    suites: ['describe'],
    modifiers: ['skip', 'only', 'todo', 'concurrent', 'each'],
    shorthands: {},
    expectedFailure: ['fails'],
    registrationFactories: ['each', 'for', 'skipIf', 'runIf'],
    tableFactories: ['each', 'for'],
    hooks: {
      beforeEach: ['beforeEach'],
      beforeAll: ['beforeAll'],
      afterEach: ['afterEach'],
      afterAll: ['afterAll'],
    },
    // `vitest/config` and type imports do not count.
    runtimeExports: ['expect', 'assert', 'expectTypeOf', 'assertType', 'vi', 'vitest'],
    assertions: {
      expect: ['expect'],
      typeLevel: ['expectTypeOf', 'assertType'],
      objects: ['assert'],
      counts: ['assertions'],
    },
    mocks: {
      objects: ['vi'],
      calls: {
        fn: 'create',
        spyOn: 'spy',
        mocked: 'wrap',
        // Vitest hoists `vi.mock` to the top of the file.
        mock: 'module_hoisted',
        doMock: 'module',
        unmock: 'module_access',
        doUnmock: 'module_access',
        importActual: 'module_access',
        importMock: 'module_access',
        stubGlobal: 'stub_global',
      },
      configureMethod: '^mock[A-Z]',
    },
  },
  execution: {
    command: 'vitest run',
    run: runVitest,
  },
  mutation: {
    mutatorRunner: 'vitest',
    minMajor: MUTATOR_MIN_VITEST_MAJOR,
    declaredMajor: MUTATOR_DECLARED_VITEST_MAJOR,
    experimental: null,
    projectPrefix: true,
    configFlag: '--config',
    unsupportedReason: () => null,
    bundledMutatorDirs(mutatorBin) {
      const dir = mutatorVitestDir(mutatorBin);

      return dir === null ? [] : [dir];
    },
    writeConfig({ root, dir, testFiles, allowDirs }) {
      return writeMutationVitestConfig({
        root,
        dir,
        ...(testFiles === undefined ? {} : { testFiles }),
        ...(allowDirs.length === 0 ? {} : { fsAllow: { dirs: allowDirs, viteUrl: projectViteUrl(root) } }),
      });
    },
  },
  recognitionFor() {
    return vitestTestRunner.recognition;
  },
  templates: () => ({
    imports(names: readonly TemplateApi[]) {
      return names.length === 0 ? [] : [`import { ${[...new Set(names)].sort().join(', ')} } from 'vitest';`];
    },
    expectToBe(actual, expected) {
      return `expect(${actual}).toBe(${expected});`;
    },
  }),
};
