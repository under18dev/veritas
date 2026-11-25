import {
  detectInstallation,
  resolvePackageVersion,
  type TemplateApi,
  type TestRunnerProvider,
  type TestRunnerTemplates,
} from '@under18dev/veritas-core';
import { runsNativeEsm } from './module-system.js';
import { JEST_CONFIG_FILES, mutationUnsupportedReason, writeMutationJestConfig } from './mutation-config.js';
import { runJest } from './run.js';

export { runsNativeEsm } from './module-system.js';
export {
  findJestConfig,
  JEST_CONFIG_FILES,
  mutationUnsupportedReason,
  writeMutationJestConfig,
} from './mutation-config.js';
export { parseJestReport, runJest } from './run.js';

/** Jest versions mutation testing works with: @mizchi/mutator's Jest integration needs Jest 30. */
export const MUTATOR_MIN_JEST_MAJOR = 30;
export const MUTATOR_DECLARED_JEST_MAJOR = 30;

/** Why mutation testing with Jest is experimental, as mutator's own documentation describes its Jest support. */
export const JEST_MUTATION_EXPERIMENTAL =
  '@mizchi/mutator runs Jest in native ESM projects only, without weak mutation (a gap that needs another input is reported as not detected), and does not support Jest projects, test.concurrent or retried tests';

function templates(root: string): TestRunnerTemplates {
  // Jest provides its API as globals; `@jest/globals` makes the imports explicit, but only if the project has it.
  const explicit = resolvePackageVersion(root, '@jest/globals') !== null;

  return {
    imports(names: readonly TemplateApi[]) {
      return explicit && names.length > 0
        ? [`import { ${[...new Set(names)].sort().join(', ')} } from '@jest/globals';`]
        : [];
    },
    expectToBe(actual, expected) {
      return `expect(${actual}).toBe(${expected});`;
    },
  };
}

/** The Jest test runner provider. */
export const jestTestRunner: TestRunnerProvider = {
  name: 'jest',
  displayName: 'Jest',
  // Jest's `fullName` is the ancestor titles and the title joined with a space.
  fullNameSeparator: ' ',
  detection: {
    packageName: 'jest',
    detect: (root, packageJson) =>
      detectInstallation(root, packageJson, {
        name: 'jest',
        displayName: 'Jest',
        packageName: 'jest',
        configFiles: JEST_CONFIG_FILES,
        packageJsonKey: 'jest',
        commands: ['jest'],
      }),
  },
  recognition: {
    modules: ['@jest/globals'],
    // Jest injects its API as globals unless `injectGlobals` is off.
    globals: true,
    tests: ['it', 'test', 'xit', 'xtest', 'fit'],
    suites: ['describe', 'xdescribe', 'fdescribe'],
    modifiers: ['skip', 'only', 'todo', 'concurrent', 'each'],
    expectedFailure: ['failing'],
    shorthands: { xit: 'skip', xtest: 'skip', xdescribe: 'skip', fit: 'only', fdescribe: 'only' },
    registrationFactories: ['each'],
    tableFactories: ['each'],
    hooks: {
      beforeEach: ['beforeEach'],
      beforeAll: ['beforeAll'],
      afterEach: ['afterEach'],
      afterAll: ['afterAll'],
    },
    runtimeExports: ['expect', 'jest'],
    assertions: { expect: ['expect'], typeLevel: [], objects: ['assert'], counts: ['assertions'] },
    mocks: {
      objects: ['jest'],
      calls: {
        fn: 'create',
        spyOn: 'spy',
        // `jest.replaceProperty(object, 'name', value)` replaces a member, as a spy does.
        replaceProperty: 'spy',
        mocked: 'wrap',
        // babel-jest and ts-jest hoist `jest.mock` above the imports of a file they compile to CommonJS; in native
        // ES modules it cannot replace static imports (see `recognitionFor`).
        mock: 'module_hoisted',
        doMock: 'module',
        // The ES module form; it is not hoisted, and only takes effect for modules imported after it.
        unstable_mockModule: 'module',
        unmock: 'module_access',
        dontMock: 'module_access',
        requireActual: 'module_access',
        requireMock: 'module_access',
        createMockFromModule: 'module_access',
      },
      configureMethod: '^mock[A-Z]',
    },
  },
  recognitionFor(root) {
    const { recognition } = jestTestRunner;

    if (!runsNativeEsm(root)) return recognition;

    // In native ES modules the static imports are bound before any code of the file runs, `jest.mock` included:
    // these calls only affect what is loaded after them (a dynamic `import()` or a `require`).
    return {
      ...recognition,
      mocks: {
        ...recognition.mocks,
        calls: {
          ...recognition.mocks.calls,
          mock: 'module_late',
          doMock: 'module_late',
          unstable_mockModule: 'module_late',
        },
      },
    };
  },
  execution: {
    command: 'jest',
    run: runJest,
  },
  mutation: {
    mutatorRunner: 'jest',
    minMajor: MUTATOR_MIN_JEST_MAJOR,
    declaredMajor: MUTATOR_DECLARED_JEST_MAJOR,
    experimental: JEST_MUTATION_EXPERIMENTAL,
    // mutator does not support Jest projects, so a leading `[label]` is part of the title.
    projectPrefix: false,
    titleKeys: 'object_key',
    configFlag: '--jest-config',
    unsupportedReason: mutationUnsupportedReason,
    // Jest loads mutator's setup files and transformer by absolute path; nothing has to be allowed.
    bundledMutatorDirs: () => [],
    writeConfig: ({ root, dir, testFiles }) =>
      writeMutationJestConfig({ root, dir, ...(testFiles === undefined ? {} : { testFiles }) }),
  },
  templates,
};
