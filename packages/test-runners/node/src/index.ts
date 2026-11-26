import type { TemplateApi, TestRunnerProvider } from '@under18dev/veritas-core';
import { detectNodeTest } from './detect.js';
import { NODE_TEST_SEPARATOR, runNodeTest } from './run.js';

export { detectNodeTest, OTHER_TEST_RUNNERS } from './detect.js';
export type { NodeTestReport } from './reporter.js';
export { NODE_TEST_SEPARATOR, parseNodeTestReport, reporterPath, runNodeTest } from './run.js';

/**
 * Why mutation testing cannot run with Node's test runner: @mizchi/mutator drives only Vitest, Jest and Playwright,
 * and has no integration that runs `node --test` against its mutants.
 */
export const NODE_TEST_MUTATION_UNSUPPORTED =
  '@mizchi/mutator cannot run tests written for the Node.js test runner (node --test): it drives only Vitest, Jest and Playwright, so no mutation evidence is collected and no test is judged meaningful_with_evidence';

/** Node's default test file patterns besides `*.test.*` (which `init` always proposes) and `test.*`. */
const EXTENSIONS = '{ts,mts,cts,js,mjs,cjs}';

/** The Node.js test runner provider: `node --test` with `node:test` and `node:assert`. */
export const nodeTestRunner: TestRunnerProvider = {
  name: 'node_test',
  displayName: 'Node.js test runner',
  // Not Node's own (it has no full name); how `runNodeTest` keys a test, as `testFullName` must build it too.
  fullNameSeparator: NODE_TEST_SEPARATOR,
  detection: {
    // Not a package: the runner is the `node:test` module of Node.js itself.
    packageName: 'node:test',
    builtIn: true,
    extraTestGlobs: [
      // `*.test.*` and `test.*` with the extensions `init`'s standard patterns leave out.
      '**/*.test.{mts,cts,cjs}',
      '**/test.{mts,cts,cjs}',
      `**/*-test.${EXTENSIONS}`,
      `**/*_test.${EXTENSIONS}`,
      `**/test-*.${EXTENSIONS}`,
      `**/test/**/*.${EXTENSIONS}`,
    ],
    detect: detectNodeTest,
  },
  recognition: {
    modules: ['node:test'],
    // What `node:test` resolves to with the types of Node.js installed.
    declarationFiles: ['@types/node/test.d.ts'],
    globals: false,
    // `import test from 'node:test'` is the `test` function.
    defaultExport: 'test',
    tests: ['test', 'it'],
    suites: ['describe', 'suite'],
    modifiers: ['skip', 'only', 'todo'],
    expectedFailure: [],
    shorthands: {},
    registrationFactories: [],
    tableFactories: [],
    // `test(name, { skip, todo, only }, fn)`; a string value (the reason) sets the option too.
    testOptions: true,
    // Node forces `.skip`, `.todo` and `.only`: `{ skip: false }` does not undo `test.skip`.
    chainedModifiersWin: true,
    // Node checks `skip !== undefined && skip !== false`: an empty reason, 0 or null still skips.
    optionsSetUnlessFalse: true,
    hooks: {
      beforeEach: ['beforeEach'],
      beforeAll: ['before'],
      afterEach: ['afterEach'],
      afterAll: ['after'],
    },
    runtimeExports: ['mock'],
    assertions: {
      expect: [],
      typeLevel: [],
      // Only what is bound to node:assert counts (resolved by symbol), never a local named `assert`.
      objects: [],
      counts: [],
      // Every value export of node:assert asserts: `assert(x)`, `assert.equal(a, b)`, `strictEqual(a, b)`, ...
      modules: ['node:assert', 'node:assert/strict', 'assert', 'assert/strict'],
    },
    mocks: {
      objects: ['mock'],
      calls: {
        fn: 'create',
        method: 'spy',
        getter: 'spy',
        setter: 'spy',
        // `mock.module` (behind --experimental-test-module-mocks) replaces a module for what loads it afterwards.
        module: 'module_late',
      },
      // `fn.mock.mockImplementation(...)`, `fn.mock.mockImplementationOnce(...)`.
      configureMethod: '^mock[A-Z]',
      // `t.mock.fn()`, `t.mock.method(object, 'name')`: the test context's own mock tracker.
      contextMember: 'mock',
      controller: 'mock',
    },
  },
  recognitionFor() {
    return nodeTestRunner.recognition;
  },
  execution: {
    command: 'node --test',
    run: runNodeTest,
  },
  mutation: {
    mutatorRunner: null,
    minMajor: null,
    declaredMajor: null,
    experimental: null,
    projectPrefix: false,
    titleKeys: 'identifier',
    configFlag: '',
    unsupportedReason: () => NODE_TEST_MUTATION_UNSUPPORTED,
    bundledMutatorDirs: () => [],
    writeConfig() {
      throw new Error(NODE_TEST_MUTATION_UNSUPPORTED);
    },
  },
  templates: () => ({
    imports(names: readonly TemplateApi[]) {
      const registrations = [...new Set(names.filter((name) => name !== 'expect'))].sort();

      return [
        ...(names.includes('expect') ? ["import assert from 'node:assert/strict';"] : []),
        ...(registrations.length > 0 ? [`import { ${registrations.join(', ')} } from 'node:test';`] : []),
      ];
    },
    expectToBe(actual, expected) {
      return `assert.strictEqual(${actual}, ${expected});`;
    },
    // Node.js runs TypeScript by stripping types, which keeps import specifiers as written.
    sourceImports: true,
  }),
};
