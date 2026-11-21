import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  type MockCallRole,
  resolveInsideRoot,
  sha256,
  stableId,
  symbolId,
  TestCase,
  type TestCase as TestCaseType,
  TestPropertyEdge,
  type TestPropertyEdge as TestPropertyEdgeType,
  type TestRunnerRecognition,
  toPosixRelative,
  type VeritasConfig,
} from '@under18dev/veritas-core';
import ts from 'typescript';
import { z } from 'zod';

export const TestInventory = z.object({
  tests: z.array(TestCase),
  edges: z.array(TestPropertyEdge),
  files: z.array(
    z.object({
      path: z.string(),
      hash: z.string(),
      /** Files inside the root the test file imports, directly or through other local files (POSIX, sorted). */
      dependencies: z.array(z.string()).default([]),
      /**
       * The file or a local file it imports runs code static analysis cannot follow (a child process, a
       * dynamic import) or imports a relative module that does not resolve, anywhere, recognized test or not.
       */
      unseenReach: z.boolean().default(false),
    }),
  ),
  diagnostics: z.array(z.object({ file: z.string(), message: z.string() })),
});
export type TestInventory = z.infer<typeof TestInventory>;

/** The test runner's API names (`TestRunnerRecognition`), as sets for lookups. */
interface RunnerApi {
  modules: Set<string>;
  tests: Set<string>;
  suites: Set<string>;
  modifiers: Set<string>;
  shorthands: Map<string, TestCaseType['modifiers'][number]>;
  expectedFailure: Set<string>;
  registrationFactories: Set<string>;
  tableFactories: Set<string>;
  beforeEach: Set<string>;
  /** Hooks that run before a test: `beforeEach` and `beforeAll`. */
  setup: Set<string>;
  hooks: Set<string>;
  runtimeExports: Set<string>;
  expect: Set<string>;
  typeLevel: Set<string>;
  assertObjects: Set<string>;
  assertionCounts: Set<string>;
  mockObjects: Set<string>;
  mockCalls: Map<string, MockCallRole>;
  configureMethod: RegExp;
}

function runnerApi(recognition: TestRunnerRecognition): RunnerApi {
  const { hooks } = recognition;

  return {
    modules: new Set(recognition.modules),
    tests: new Set(recognition.tests),
    suites: new Set(recognition.suites),
    modifiers: new Set(recognition.modifiers),
    shorthands: new Map(Object.entries(recognition.shorthands)),
    expectedFailure: new Set(recognition.expectedFailure),
    registrationFactories: new Set(recognition.registrationFactories),
    tableFactories: new Set(recognition.tableFactories),
    beforeEach: new Set(hooks.beforeEach),
    setup: new Set([...hooks.beforeEach, ...hooks.beforeAll]),
    hooks: new Set([...hooks.beforeEach, ...hooks.beforeAll, ...hooks.afterEach, ...hooks.afterAll]),
    runtimeExports: new Set(recognition.runtimeExports),
    expect: new Set(recognition.assertions.expect),
    typeLevel: new Set(recognition.assertions.typeLevel),
    assertObjects: new Set(recognition.assertions.objects),
    assertionCounts: new Set(recognition.assertions.counts),
    mockObjects: new Set(recognition.mocks.objects),
    mockCalls: new Map(Object.entries(recognition.mocks.calls)),
    configureMethod: new RegExp(recognition.mocks.configureMethod),
  };
}

/**
 * The API of the test runner whose tests are being inventoried. `inventoryTests` is synchronous and sets it for the
 * duration of one call; outside a call nothing is recognized.
 */
let runner: RunnerApi = runnerApi({
  modules: [],
  globals: false,
  tests: [],
  suites: [],
  modifiers: [],
  shorthands: {},
  expectedFailure: [],
  registrationFactories: [],
  tableFactories: [],
  hooks: { beforeEach: [], beforeAll: [], afterEach: [], afterAll: [] },
  runtimeExports: [],
  assertions: { expect: [], typeLevel: [], objects: [], counts: [] },
  mocks: { objects: [], calls: {}, configureMethod: '(?!)' },
});

export function testId(file: string, suitePath: string[], name: string): string {
  return stableId('T', { file: file.split('\\').join('/'), suitePath, name });
}

/**
 * Inventory the tests of a project statically: what each test registers, calls and asserts. `recognition` names the
 * test API of the project's test runner (its provider's `recognition`).
 */
export function inventoryTests(options: {
  root: string;
  config: VeritasConfig;
  recognition: TestRunnerRecognition;
  files?: string[];
}): TestInventory {
  const previous = runner;
  runner = runnerApi(options.recognition);

  try {
    return inventory(options);
  } finally {
    runner = previous;
  }
}

function inventory(options: { root: string; config: VeritasConfig; files?: string[] }): TestInventory {
  const root = path.resolve(options.root);
  // Module resolution depends on the compiler options and files of this project, and so does what code reaches.
  resolvedModules.clear();
  projectReachCache.clear();
  const testFiles =
    options.files?.map((file) =>
      resolveInsideRoot(root, path.isAbsolute(file) ? path.relative(root, file) : file),
    ) ?? collectFiles(root, options.config.analysis.testInclude, options.config.analysis.exclude);
  const uniqueFiles = [...new Set(testFiles.map((file) => path.resolve(file)))].filter(isSourceFile);
  const projectFiles = collectFiles(
    root,
    options.config.analysis.include,
    options.config.analysis.exclude,
  ).filter((file) => !uniqueFiles.includes(path.resolve(file)) && !isTestSupportFile(root, file));
  const compilerOptions = readCompilerOptions(root, options.config);
  const program = ts.createProgram([...projectFiles, ...uniqueFiles], compilerOptions);
  const checker = program.getTypeChecker();
  const sourceFiles = new Map<string, ts.SourceFile>();

  for (const sourceFile of program.getSourceFiles())
    sourceFiles.set(path.resolve(sourceFile.fileName), sourceFile);
  // Assertion helpers and mock utilities kept with the source (`src/vitest/expectIssue.ts`, `src/test-utils.ts`)
  // are test code: they stay in the program so their imports resolve, but calls into them are followed as
  // helpers, not counted as project targets.
  const projectSet = new Set(
    projectFiles
      .map((file) => path.resolve(file))
      .filter((file) => {
        const source = sourceFiles.get(file);

        return !source || !importsRunnerRuntime(source);
      }),
  );
  const tests: TestCaseType[] = [];
  const diagnostics: { file: string; message: string }[] = [];

  const callInfoCache = new Map<Invocation, CallInfo>();
  const helperInfoCache = new Map<ts.Node, CallInfo>();

  for (const file of uniqueFiles) {
    const source = sourceFiles.get(file);

    if (!source) continue;

    for (const diagnostic of [
      ...program.getSyntacticDiagnostics(source),
      ...program.getSemanticDiagnostics(source),
    ]) {
      diagnostics.push({
        file: toPosixRelative(root, file),
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      });
    }
    const ctx: Ctx = {
      checker,
      projectSet,
      root,
      program,
      compilerOptions,
      file,
      callInfo: callInfoCache,
      helperInfo: helperInfoCache,
    };
    const mocks = collectMocks(source, ctx);
    visitTests(source, [], [], file, mocks, ctx, tests);
  }

  const edges: TestPropertyEdgeType[] = [];

  for (const test of tests) {
    for (const symbol of test.calledSymbols) {
      const evidence: TestPropertyEdgeType['evidence'] = [
        {
          kind: 'static_call',
          detail: 'Project symbol called from the test, directly, through a test helper or in shared setup',
          artifactIds: [],
        },
      ];

      if (test.targetCalls.some((call) => call.symbol === symbol && call.asserted)) {
        evidence.push({
          kind: 'direct_assertion',
          detail: 'Result of project symbol flows into an assertion',
          artifactIds: [],
        });
      }
      edges.push({
        id: stableId('E', { testId: test.id, symbol, propertyId: null }),
        testId: test.id,
        symbol,
        propertyId: null,
        evidence,
      });
    }
  }

  const usedCache = new Map<ts.SourceFile, ts.SourceFile[]>();
  // For module names TypeScript does not resolve itself, such as the argument of `vi.mock('./x')`.
  const resolveModule = (name: string, containingFile: string): ts.SourceFile | undefined => {
    const resolved = ts.resolveModuleName(name, containingFile, compilerOptions, ts.sys).resolvedModule;

    return resolved ? program.getSourceFile(resolved.resolvedFileName) : undefined;
  };
  const files = uniqueFiles.map((file) => {
    const source = sourceFiles.get(file);
    // Every file the test loads, which is what decides whether something it reaches is unseen.
    const loaded = source ? localDependencies(source, checker, root) : [];
    const reached = [source, ...loaded.map((dependency) => sourceFiles.get(path.resolve(root, dependency)))];

    return {
      path: toPosixRelative(root, file),
      hash: sha256(readFileSync(file)),
      // Only the files whose code the test may run: mutation testing selects tests by these.
      dependencies: source ? usedDependencies(source, checker, root, usedCache, resolveModule) : [],
      // An unparsed file is unknown too.
      unseenReach:
        !source || reached.some((reachedFile) => reachedFile && hasUnseenReach(reachedFile, checker)),
    };
  });

  return TestInventory.parse({ tests, edges, files, diagnostics });
}

interface Ctx {
  checker: ts.TypeChecker;
  projectSet: Set<string>;
  root: string;
  program: ts.Program;
  compilerOptions: ts.CompilerOptions;
  /** Absolute path of the test file being analysed. */
  file: string;
  /** Per call: the project symbols it reaches. Also guards helper recursion. */
  callInfo: Map<Invocation, CallInfo>;
  helperInfo: Map<ts.Node, CallInfo>;
}

/**
 * A mock, or the part of an object holding mocks, by the variable at its root and the property path below it:
 * `onSave` is `{ onSave, [] }`, `props.onSave` is `{ props, ['onSave'] }`. An empty path is the whole value.
 */
interface MockReference {
  symbol: ts.Symbol;
  path: string[];
  /** Properties right below `path` that were not handed over (replaced by a later JSX attribute). */
  except?: string[];
}

/** Whether an assertion reading `keys` of a helper's result (`null`: all of it) reads what carries `target`. */
function keysMatch(keys: Set<string> | null | undefined, target: Target): boolean {
  return !target.resultKeys || !keys || target.resultKeys.some((key) => keys.has(key));
}

/** Whether handing over `given` hands over the mock `read` checks: the whole value, or a property above it. */
function covers(given: MockReference, read: MockReference): boolean {
  const below = read.path[given.path.length];

  return (
    given.symbol === read.symbol &&
    given.path.every((name, index) => read.path[index] === name) &&
    !(below !== undefined && given.except?.includes(below))
  );
}

/**
 * Code that runs a function: a call, a constructor call (`new X()`), a tagged template (`` tag`...` ``) or a JSX
 * element, which renders the component its tag names with the attributes as props.
 */
type Invocation =
  | ts.CallExpression
  | ts.NewExpression
  | ts.TaggedTemplateExpression
  | ts.JsxSelfClosingElement
  | ts.JsxOpeningElement;

function isInvocation(node: ts.Node): node is Invocation {
  return (
    ts.isCallExpression(node) ||
    ts.isNewExpression(node) ||
    ts.isTaggedTemplateExpression(node) ||
    isJsxInvocation(node)
  );
}

function isJsxInvocation(node: ts.Node): node is ts.JsxSelfClosingElement | ts.JsxOpeningElement {
  return ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node);
}

function calleeOf(node: Invocation): ts.Expression {
  if (isJsxInvocation(node)) return node.tagName as ts.Expression;

  return ts.isTaggedTemplateExpression(node) ? node.tag : node.expression;
}

/**
 * The values an invocation passes: its arguments, the substitutions of a tagged template, or the attribute values,
 * spread props and expression children of a JSX element (not positional: a component takes them as one object).
 */
function argumentsOf(node: Invocation): readonly ts.Expression[] {
  if (isJsxInvocation(node)) {
    const values: ts.Expression[] = [];

    for (const attribute of node.attributes.properties) {
      if (ts.isJsxSpreadAttribute(attribute)) values.push(attribute.expression);
      else if (attribute.initializer && ts.isJsxExpression(attribute.initializer)) {
        if (attribute.initializer.expression) values.push(attribute.initializer.expression);
      }
    }

    if (ts.isJsxOpeningElement(node))
      for (const child of node.parent.children)
        if (ts.isJsxExpression(child) && child.expression) values.push(child.expression);

    return values;
  }

  if (!ts.isTaggedTemplateExpression(node)) return node.arguments ?? [];

  return ts.isTemplateExpression(node.template)
    ? node.template.templateSpans.map((span) => span.expression)
    : [];
}

interface Target {
  symbol: string;
  /** The call's arguments are the project function's own (not a helper's or a method's on a project value). */
  ownArgs: boolean;
  /** A helper already asserts on this call's result. */
  assertedInside: boolean;
  /** The project call's result is (part of) what the call returns, so asserting on the call checks it. */
  flowsToResult: boolean;
  /** A component rendered as JSX (directly, or by a helper or local component): its output is in the document. */
  rendered?: boolean;
  /**
   * A component a helper returns as JSX (`function make() { return <Dialog />; }`): rendered only where the result
   * of a call to the helper is mounted, which each call decides.
   */
  deferred?: boolean;
  /**
   * Mocks (or objects holding mocks) declared outside the helper that the helper handed to this project call (`const
   * renderDialog = () => render(<Dialog onSave={onSave} />)`): asserting on how they were called checks what the
   * call did with them.
   */
  observedBy?: MockReference[];
  /**
   * A rendered component whose content in the test is only what the test itself supplies as children (`<Providers>
   * <Button>Go</Button></Providers>`): a query of the page may find just that content, so it does not observe it.
   */
  passThrough?: boolean;
  /**
   * The helper returns mocks (or an object holding them) it handed to this project call (`const props = { onNever:
   * vi.fn() }; render(<Card {...props} />); return props;`).
   */
  returnsMocks?: boolean;
  /**
   * The properties of the helper's result through which this call's output or the mocks handed to it come out
   * (`return { used, unused }` with only `used` handed over gives `['used']`); absent when it is the whole result.
   */
  resultKeys?: string[];
}

interface CallInfo {
  targets: Target[];
  /** The call runs a helper that contains an assertion. */
  helperAsserts: boolean;
  /** The call runs code static analysis cannot follow: a child process or a dynamic import. */
  opaque: boolean;
  /** The call runs a helper that asserts on a Testing Library query of the document (`screen.getByText(...)`). */
  observesDocument?: boolean;
}

interface BodyAnalysis {
  calls: { node: Invocation; target: Target }[];
  assertions: ts.CallExpression[];
  /** Calls in the body whose result (or a value derived from it) reaches an assertion subject. */
  asserted: Set<Invocation>;
  unresolvedImports: Set<string>;
  helperAsserts: boolean;
  opaque: boolean;
  /** Calls whose result flows into what the body returns. */
  returned: Set<Invocation>;
  /**
   * The body awaits a project call and asserts only on locals it sets to constants after that (`await acquire();
   * values.push(1); expect(values)…`): it checks that the call settles, not anything the call returns.
   */
  progressOnly: boolean;
  /**
   * Calls whose behaviour an assertion observes other than through their result: a rendered component queried in
   * the document, or a project call a mock was handed to in a helper.
   */
  observed: Set<BodyAnalysis['calls'][number]>;
  /**
   * Calls whose code could reach what an assertion reads without being handed it (a mocked module it imports, a
   * global it reads, a global API it calls), with the routes: evidence that the link is possible, not that it is made.
   */
  reached: Map<BodyAnalysis['calls'][number], Set<string>>;
  /** Mocks (or objects holding mocks) declared outside the body that the body hands to project calls, by call. */
  handed: Map<Invocation, MockReference[]>;
  /** Variables holding mocks or objects holding mocks, with the part handed over, by the calls they are handed to. */
  mockHolders: Map<Invocation, MockReference[]>;
  /** An assertion of the body (or of a helper it calls) checks a Testing Library query of the document. */
  observesDocument: boolean;
  /** Calls whose output a returned object literal carries, by the properties carrying it; `null` is all of it. */
  returnedKeys: Map<Invocation, Set<string> | null>;
  /** The properties of a call's result that assertions read, by call (see `asserted`); `null` is all of it. */
  assertedKeys: Map<Invocation, Set<string> | null>;
  /**
   * Asserted calls read only through their render output: a pass-through wrapper is not credited with what the
   * test itself supplied as its children (`render(<Providers><button>Hi</button></Providers>).getByText('Hi')`).
   */
  outputOnly: Set<Invocation>;
}

/**
 * Calls, assertions and result flow in a test body or helper body. Values are followed through local and
 * enclosing (describe-level or module-level) variables of the same file, including `let` set in a hook.
 */
function analyzeBody(
  body: ts.Node,
  ctx: Ctx,
  contextAssertion: (node: ts.CallExpression) => boolean = () => false,
  setupRenders: Invocation[] = [],
  setupWrites: DocumentWrite[] = [],
  // A helper keeps the components it returns for its callers to judge; a test body has no caller to mount them.
  keepDeferred = true,
): BodyAnalysis {
  const { checker } = ctx;
  // Components rendered by shared setup that runs before the body (`beforeEach(() => render(<Dialog />))`).
  const setupEntries = new Set<BodyAnalysis['calls'][number]>();
  // Where an element made outside the body is mounted in it (`render(ui)`).
  const mountedAt = new Map<Invocation, number>();
  const source = body.getSourceFile();
  const calls: BodyAnalysis['calls'] = [];
  const recorded = new Set<Invocation>();
  const assertions: ts.CallExpression[] = [];
  const unresolvedImports = new Set<string>();
  let helperAsserts = false;
  let opaque = false;
  // Where a helper that asserts on a Testing Library query of the document is called.
  const documentChecks: number[] = [];
  const handed: BodyAnalysis['handed'] = new Map();
  // Variables holding mocks, or objects holding mocks, by the calls they were handed to.
  const mockHolders: BodyAnalysis['mockHolders'] = new Map();
  const record = (node: Invocation): boolean => {
    // Code in an `onClick={() => …}` handler of a DOM or third-party element runs only when an event fires.
    if (contains(body, node) && inUnfiredHandler(node, body, ctx)) return false;
    const info = callInfo(node, ctx);

    if (!recorded.has(node)) {
      recorded.add(node);

      for (const target of info.targets) if (keepDeferred || !target.deferred) calls.push({ node, target });
      helperAsserts ||= info.helperAsserts;
      opaque ||= info.opaque;

      // A helper that asserts on the page observes what rendered before it was called; what it renders itself is
      // judged inside it, in its own order (`const before = screen.queryByText(…); render(…); expect(before)…`).
      if (info.observesDocument) documentChecks.push(node.getStart());
    }

    return info.targets.some((target) => keepDeferred || !target.deferred);
  };
  // `const ui = <Dialog />` holds the element's description, not what the component renders: reading `ui.props` reads
  // what the test wrote. The element still runs where it is mounted.
  const notDescriptor = (value: ts.Expression, sources: Invocation[]) =>
    sources.filter(
      (item) =>
        !(
          isJsxInvocation(item) &&
          jsxTop(ts.isJsxOpeningElement(item) ? item.parent : item, checker) === value
        ),
    );
  // Variables holding (something derived from) a project call's result, keyed by symbol so shadowing is respected.
  const localCalls = new Map<ts.Symbol, Invocation[]>();
  const outerDone = new Set<ts.Symbol>();
  const sourcesOf = (expressions: ts.Expression[]): Invocation[] => {
    const found = new Set<Invocation>();

    for (const expression of expressions) {
      // A function value is a helper; it is followed where it is called, not where it is defined.
      if (isFunctionLike(skipParens(expression))) continue;
      const direct = [expression, ...descendants(expression)].filter(
        (item): item is Invocation => isInvocation(item) && record(item),
      );

      for (const item of direct.length > 0 ? direct : trackedCalls(expression)) found.add(item);

      // `render(ui)` with `const ui = <Dialog />`: what the render returns comes from the element it mounts.
      for (const item of [expression, ...descendants(expression)])
        if (ts.isCallExpression(item))
          for (const argument of item.arguments) {
            const value = skipParens(argument);
            const initializer = ts.isIdentifier(value)
              ? variableInitializer(checker.getSymbolAtLocation(value)?.valueDeclaration)
              : undefined;

            if (!initializer || !isMounted(mountedExpression(value, ctx, 0))) continue;

            for (const element of [initializer, ...descendants(initializer)])
              if (
                isJsxInvocation(element) &&
                jsxTop(ts.isJsxOpeningElement(element) ? element.parent : element, checker) === initializer &&
                record(element)
              )
                found.add(element);
          }
    }

    return [...found];
  };
  const outerCalls = (symbol: ts.Symbol): void => {
    if (outerDone.has(symbol)) return;
    outerDone.add(symbol);
    const expressions: ts.Expression[] = [];

    for (const declaration of symbol.declarations ?? []) {
      if (!ts.isVariableDeclaration(declaration) || declaration.getSourceFile() !== source) continue;

      if (contains(body, declaration)) continue;

      if (declaration.initializer) expressions.push(declaration.initializer);
      else expressions.push(...assignmentsTo(symbol, source, checker));
    }
    // `const ui = <Dialog />` outside the body describes an element: it runs only where this body mounts it
    // (`render(ui)`), which records it there, not where another test does.
    let sources = sourcesOf(expressions.filter((expression) => !isElementDescription(expression, checker)));
    const declaration = symbol.valueDeclaration;

    // A mock made outside the body (`const onChange = vi.fn()`) and handed to project code in shared setup
    // (`beforeEach(() => { func = debounce(opts, onChange); })`) records what that call does with it.
    if (
      sources.length === 0 &&
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.getSourceFile() === source &&
      holdsMock(declaration, checker)
    )
      sources = invocationsGiven(declaration, checker).filter(
        (node) => !contains(body, node) && runsBefore(node, body) && record(node),
      );

    if (sources.length > 0) localCalls.set(symbol, sources);
  };
  const trackedCalls = (expression: ts.Node): Invocation[] => {
    const found = new Set<Invocation>();

    for (const item of [expression, ...descendants(expression)]) {
      if (!ts.isIdentifier(item)) continue;
      // `return { onChange }` hands back the variable, not a property of its own.
      const symbol = valueSymbol(item, checker);

      if (!symbol) continue;

      if (!localCalls.has(symbol)) outerCalls(symbol);

      for (const call of localCalls.get(symbol) ?? []) found.add(call);
    }

    return [...found];
  };
  const bind = (identifiers: ts.Identifier[], sources: Invocation[], merge = false) => {
    if (sources.length === 0) return;

    for (const identifier of identifiers) {
      const symbol = checker.getSymbolAtLocation(identifier);

      if (!symbol) continue;

      // Adding to a variable declared outside the body keeps what its declaration already carries.
      if (merge && !localCalls.has(symbol)) outerCalls(symbol);
      const previous = merge ? (localCalls.get(symbol) ?? []) : [];
      localCalls.set(symbol, [...new Set([...previous, ...sources])]);
    }
  };
  // Project code runs the callbacks it is given: what they write to is an output of that call. So is the
  // state of a local object after a project method ran on it (`client.complete(); client.cachedResponses`), or
  // after it was passed to project code (`deepMerge(target, source); target.x`), which may change it in place.
  const bindCallOutputs = (call: Invocation) => {
    const callee = skipParens(calleeOf(call));

    if (ts.isPropertyAccessExpression(callee)) {
      let receiver = skipParens(callee.expression);

      while (ts.isPropertyAccessExpression(receiver) || ts.isElementAccessExpression(receiver))
        receiver = skipParens(receiver.expression);
      const declaration = ts.isIdentifier(receiver)
        ? checker.getSymbolAtLocation(receiver)?.valueDeclaration
        : undefined;

      if (ts.isIdentifier(receiver) && declaration?.getSourceFile() === source)
        bind([receiver], [call], true);
    }
    const callbacks = new Set<ts.Node>();

    for (const [index, argument] of argumentsOf(call).entries()) {
      const value = skipParens(argument);

      if (
        ts.isIdentifier(value) &&
        passedByReference(value, checker) &&
        mayChangeArgument(call, index, checker)
      )
        if (checker.getSymbolAtLocation(value)?.valueDeclaration?.getSourceFile() === source)
          bind([value], [call], true);
    }

    // Callbacks the project function itself receives and may call: what it passes them is its output.
    const called = new Set<ts.Node>();
    const projectCalls =
      callInfo(call, ctx).targets.some((target) => target.ownArgs) ||
      projectReceiver(call, ctx) !== undefined;

    for (const [index, argument] of argumentsOf(call).entries()) {
      const receives = projectCalls && mayCallArgument(call, index, checker);

      for (const item of [argument, ...descendants(argument)]) {
        if (isFunctionLike(item) && handedOver(item, argument)) {
          callbacks.add(item);

          if (receives) called.add(item);
        }

        if (!ts.isIdentifier(item)) continue;
        const declaration = checker.getSymbolAtLocation(item)?.valueDeclaration;

        if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer)
          for (const inner of [declaration.initializer, ...descendants(declaration.initializer)])
            if (isFunctionLike(inner) && handedOver(inner, declaration.initializer)) {
              callbacks.add(inner);

              if (receives && handedOver(item, argument)) called.add(inner);
            }
      }
    }

    for (const callback of callbacks) bind(writtenOuterIdentifiers(callback, checker), [call], true);

    // A mock records how it is called wherever it sits in the arguments: in an options object
    // (`cloneDeep(src, { cloneObject })`) or wrapped by another call (`run(wrap(onDone))`).
    const holders = mockHoldersPassed(call, checker);

    for (const declaration of holders.mocks)
      if (declaration.getSourceFile() === source) bind(bindingIdentifiers(declaration.name), [call], true);

    // An object holding mocks (`render(<Dialog {...props} />)`) is not followed as a value: only an assertion on how
    // one of the mocks handed over was called checks the call (`expect(props.onSave).toHaveBeenCalled()`).
    for (const { declaration, path, except } of [
      ...holders.mocks.map((declaration) => ({ declaration, path: [] as string[], except: undefined })),
      ...holders.containers,
    ]) {
      if (declaration.getSourceFile() !== source) continue;

      for (const identifier of bindingIdentifiers(declaration.name)) {
        const symbol = checker.getSymbolAtLocation(identifier);

        if (!symbol) continue;
        const reference = { symbol, path, ...(except ? { except } : {}) };
        mockHolders.set(call, [...(mockHolders.get(call) ?? []), reference]);

        // A mock of an enclosing scope that a helper hands over (`const renderDialog = () => render(<Dialog
        // onSave={onSave} />)`) is checked where the helper is called, which this body's caller sees.
        if (!contains(body, declaration)) handed.set(call, [...(handed.get(call) ?? []), reference]);
      }
    }

    // `mapKeys(obj, (key) => { expect(key).toBe('a'); })` checks what mapKeys passes to the callback.
    for (const callback of called)
      if (isFunctionLike(callback))
        bind(
          callback.parameters.flatMap((parameter) => bindingIdentifiers(parameter.name)),
          [call],
        );
  };

  // The variable at the root of `a.b[c]`, when it is declared in this file.
  const localRoot = (expression: ts.Expression): ts.Identifier | undefined => {
    let current = skipParens(expression);

    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current))
      current = skipParens(current.expression);

    if (!ts.isIdentifier(current)) return undefined;
    const declaration = checker.getSymbolAtLocation(current)?.valueDeclaration;

    return declaration?.getSourceFile() === source ? current : undefined;
  };

  for (const node of setupRenders) {
    if (recorded.has(node)) continue;
    recorded.add(node);

    for (const target of callInfo(node, ctx).targets)
      if (target.rendered) {
        const entry = { node, target };
        calls.push(entry);
        setupEntries.add(entry);
      }
    // What the setup render was handed (`render(<Dialog {...props} />)`) is checked as if handed here.
    bindCallOutputs(node);
  }

  for (const node of descendants(body)) {
    if (ts.isTryStatement(node) && node.catchClause?.variableDeclaration)
      bind(
        bindingIdentifiers(node.catchClause.variableDeclaration.name),
        descendants(node.tryBlock).filter((item): item is Invocation => isInvocation(item) && record(item)),
      );

    if (ts.isVariableDeclaration(node) && node.initializer)
      bind(bindingIdentifiers(node.name), notDescriptor(node.initializer, sourcesOf([node.initializer])));

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    )
      bind([node.left], notDescriptor(node.right, sourcesOf([node.right])));

    // Storing a project result in a local (`Circle.prototype = create(...)`, `actual.push(parse(x))`) makes the
    // local carry it.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
    ) {
      const local = localRoot(node.left);

      if (local) bind([local], sourcesOf([node.right]), true);
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const local = localRoot(node.expression.expression);

      if (local) bind([local], sourcesOf([...node.arguments]), true);
    }

    if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer))
      bind(
        node.initializer.declarations.flatMap((declaration) => bindingIdentifiers(declaration.name)),
        sourcesOf([node.expression]),
      );

    // `acquire().then(() => { values.push(3); })`: a continuation runs with the result of the call it follows,
    // so what it writes and the value it receives are outputs of that call.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      CONTINUATIONS.has(node.expression.name.text)
    ) {
      const sources = sourcesOf([node.expression.expression]);

      for (const argument of sources.length > 0 ? node.arguments : []) {
        const continuation = skipParens(argument);

        if (!isFunctionLike(continuation)) continue;
        bind(writtenOuterIdentifiers(continuation, checker), sources, true);
        bind(
          continuation.parameters.flatMap((parameter) => bindingIdentifiers(parameter.name)),
          sources,
        );
      }
    }

    // JSX rendered with a JSX runtime of the project (`/** @jsxImportSource ./ */`) calls project code that the
    // element syntax does not show.
    if (
      (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) &&
      projectJsxRuntime(source)
    )
      opaque = true;

    if (!isInvocation(node)) continue;

    // `render(ui)` with `const ui = <Dialog />` made outside the body mounts that element here.
    if (ts.isCallExpression(node))
      for (const argument of node.arguments) {
        const value = skipParens(argument);
        const initializer = ts.isIdentifier(value)
          ? variableInitializer(checker.getSymbolAtLocation(value)?.valueDeclaration)
          : undefined;

        if (!initializer || contains(body, initializer) || !isMounted(mountedExpression(value, ctx, 0)))
          continue;

        for (const element of [initializer, ...descendants(initializer)])
          if (
            isJsxInvocation(element) &&
            jsxTop(ts.isJsxOpeningElement(element) ? element.parent : element, checker) === initializer &&
            record(element)
          ) {
            bindCallOutputs(element);
            mountedAt.set(
              element,
              Math.min(mountedAt.get(element) ?? Number.POSITIVE_INFINITY, node.getStart()),
            );
          }
      }

    if (record(node)) bindCallOutputs(node);
    else {
      const specifier = unresolvedImportOf(calleeOf(node), ctx);

      if (specifier !== undefined) unresolvedImports.add(specifier);
    }

    if (ts.isCallExpression(node) && (isExpectCall(node) || isAssertCall(node) || contextAssertion(node)))
      assertions.push(node);
  }
  // What a helper returns may come from enclosing variables, e.g. `const of = (n) => candidates.filter(...)`.
  const returned = new Set(
    sourcesOf(ts.isBlock(body) ? returnedExpressions(body) : ts.isExpression(body) ? [body] : []),
  );
  const asserted = new Set<Invocation>();
  const assertedKeys: BodyAnalysis['assertedKeys'] = new Map();
  // Asserted calls read through their render output (queries, container), and through anything else.
  const outputReads = new Set<Invocation>();
  const otherReads = new Set<Invocation>();
  const mergeKeys = (
    map: Map<Invocation, Set<string> | null>,
    call: Invocation,
    keys: Set<string> | null,
  ) => {
    const previous = map.get(call);

    if (previous === null || keys === null) map.set(call, null);
    else map.set(call, new Set([...(previous ?? []), ...keys]));
  };
  // The properties of `call`'s result that `value` reads: `setup().used`, `const { used } = setup()`, or `r.used`
  // with `const r = setup()`. `null` when it reads the whole result or the path is not that plain.
  const keysRead = (value: ts.Node, call: Invocation): Set<string> | null => {
    if (value === call || contains(value, call)) {
      let current: ts.Node = call;

      while (
        ts.isParenthesizedExpression(current.parent) ||
        ts.isAwaitExpression(current.parent) ||
        ts.isNonNullExpression(current.parent)
      )
        current = current.parent;
      const parent = current.parent;
      const name =
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === current
          ? memberName(parent)
          : undefined;

      return name === undefined ? null : new Set([name]);
    }
    const keys = new Set<string>();

    for (const item of [value, ...descendants(value)]) {
      if (!ts.isIdentifier(item)) continue;
      const symbol = valueSymbol(item, checker);

      if (!symbol || !(localCalls.get(symbol) ?? []).includes(call)) continue;
      const declaration = symbol.valueDeclaration;
      const initializer = variableInitializer(declaration);

      // Only a local set straight from the call names a property of its result.
      if (!initializer || !(initializer === call || contains(initializer, call))) return null;

      if (declaration && ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
        const property = declaration.propertyName ?? declaration.name;

        if (
          declaration.dotDotDotToken ||
          !ts.isIdentifier(property) ||
          declaration.parent.parent !== initializer.parent
        )
          return null;
        keys.add(property.text);
      } else {
        const [first] = memberPath(item);

        if (first === undefined) return null;
        keys.add(first);
      }
    }

    return keys.size > 0 ? keys : null;
  };

  // Mocks the body calls itself (`onSave(); expect(onSave).toHaveBeenCalled()`): a call count on them may count the
  // test's own calls, so it is not taken as checking project code.
  const selfCalled: MockReference[] = [];

  for (const node of descendants(body))
    if (ts.isCallExpression(node) && !inNestedFunction(node, body)) {
      const reference = mockReference(node.expression, checker);

      if (reference) selfCalled.push(reference);
    }
  // Content the test puts there itself (`document.body.innerHTML = …`, `document.body.appendChild(node)`) may be what
  // any later read of the page finds; other writes (`document.body.className = 'dark'`) only that member.
  // Writes of shared setup that runs before the body (`beforeEach(() => { document.body.innerHTML = … })`) come first.
  const documentWrites: DocumentWrite[] = [...setupWrites];

  for (const node of descendants(body)) {
    // A write in a function that never runs (`const reset = () => { document.body.innerHTML = ''; }`) writes nothing.
    if (!writeRuns(node, body, checker)) continue;
    const write = documentWriteOf(node, body, checker);

    // A write in a local function happens where the function is called (`render(…); expect(…); reset();`).
    if (write)
      documentWrites.push(
        inNestedFunction(node, body) ? { ...write, end: invokedAt(node, body, checker) } : write,
      );

    // A helper of the file written outside the body (`function writePage() { document.body.innerHTML = … }`) writes
    // where the body calls it.
    if (ts.isCallExpression(node) && ts.isIdentifier(skipParens(node.expression))) {
      const fn = localFunction(skipParens(node.expression), checker);

      if (fn && isFunctionLike(fn) && fn.body && !contains(body, fn)) {
        const at = inNestedFunction(node, body) ? invokedAt(node, body, checker) : node.getStart();

        for (const inner of descendants(fn.body)) {
          const helperWrite = !inNestedFunction(inner, fn.body)
            ? documentWriteOf(inner, fn.body, checker)
            : undefined;

          if (helperWrite) documentWrites.push({ ...helperWrite, end: at });
        }
      }
    }
  }

  // Where an assertion runs: its end, or where the local function or callback holding it is called.
  const observationAt = (assertion: ts.CallExpression) =>
    inNestedFunction(assertion, body) ? invokedAt(assertion, body, checker) : assertion.getEnd();
  const setupNodes = () => new Set([...setupEntries].map((entry) => entry.node));
  // Where a call of the body runs: setup first, an element where the call that mounts it runs (`const ui = <Dialog
  // />; …; render(ui)`), code in a local function where that is called, anything else where it is written. Code
  // outside the body runs before it. Not found: never.
  const executedAt = (node: Invocation): number => {
    if (setupNodes().has(node)) return Number.NEGATIVE_INFINITY;
    const outside = mountedAt.get(node);

    if (outside !== undefined) return outside;

    if (!contains(body, node)) return Number.NEGATIVE_INFINITY;
    const invoked = invokedAt(node, body, checker);

    if (invoked !== node.getStart()) return invoked;

    if (!isJsxInvocation(node)) return node.getStart();
    const top = jsxTop(ts.isJsxOpeningElement(node) ? node.parent : node, checker);
    const holder = top.parent;

    if (!ts.isVariableDeclaration(holder) || holder.initializer !== top || !ts.isIdentifier(holder.name))
      return node.getStart();
    const symbol = checker.getSymbolAtLocation(holder.name);
    const mounts = (symbol ? referencesOf(symbol, source, checker) : [])
      .filter(
        (item) => item !== holder.name && contains(body, item) && isMounted(mountedExpression(item, ctx, 0)),
      )
      .map((item) => item.getStart());

    return mounts.length > 0 ? Math.min(...mounts) : Number.POSITIVE_INFINITY;
  };
  const reaches = new Map(
    assertions.map(
      (assertion) =>
        [assertion, assertionReach(assertion, checker, documentWrites, observationAt(assertion))] as const,
    ),
  );
  // Reading such a mock's calls, through a matcher (`toHaveBeenCalled`) or its state (`onSave.mock.calls`), may
  // read the test's own calls: what it says about the calls it was handed to is left out, and nothing else.
  const isSelfCalled = (root: MockReference) =>
    selfCalled.some(
      (called) => called.symbol === root.symbol && called.path.join('.') === root.path.join('.'),
    );
  const selfCalledEvidence = (assertion: ts.CallExpression): Set<Invocation> =>
    new Set(
      (reaches.get(assertion)?.mockRoots ?? [])
        .filter(isSelfCalled)
        .flatMap((root) => trackedCalls(root.identifier)),
    );

  // Whether a call's render result is Testing Library's (`render`, a render helper), whose `debug`, `unmount` and
  // uncalled queries are API. Other renderers' results (Enzyme's `debug()`, `html()`, `find()`) are output.
  const testingLibraryResult = (call: Invocation): boolean => {
    if (!isJsxInvocation(call)) return true;
    const top = jsxTop(ts.isJsxOpeningElement(call) ? call.parent : call, checker);
    const mount = top.parent;

    if (!ts.isCallExpression(mount) || !mount.arguments.includes(top as ts.Expression)) return true;
    const callee = skipParens(mount.expression);
    const name = ts.isIdentifier(callee)
      ? importedName(callee, checker)
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : undefined;

    return name === undefined || !(STRING_RENDERING_FUNCTIONS.has(name) || name in AMBIGUOUS_RENDERERS);
  };

  // Whether a query read at `position` may find content the test itself put into the page before it.
  const queryAfterWrite = (member: string | undefined, position: number) =>
    member !== undefined &&
    DOCUMENT_QUERY.test(member) &&
    documentWrites.some(
      (write) => write.content && write.end < position && !(write.empty && TEXT_QUERY.test(member)),
    );

  // Either side of a comparison counts: `expect(['a', 'b']).toContain(result.status)` checks the result.
  for (const assertion of assertions) {
    const excluded = selfCalledEvidence(assertion);
    const runsSubject = runsCallback(assertion);

    for (const value of comparedValues(assertion)) {
      // A call whose result is a render result: an element mounted into the page, or a helper call that renders.
      const rendersOutput = (call: Invocation) =>
        isJsxInvocation(call) || calls.some((entry) => entry.node === call && entry.target.rendered === true);
      // Only what the assertion evaluates: code in a function it never runs (`expect(() => onSave.mock.calls)`)
      // reads nothing.
      const evaluated = (node: ts.Node) => runsWithin(node, value, assertion);

      for (const identifier of [value, ...descendants(value)].filter(ts.isIdentifier).filter(evaluated))
        for (const call of trackedCalls(identifier)) {
          if (excluded.has(call)) continue;

          // A call that runs after the assertion (`expect(cb).not.toHaveBeenCalled(); render(<Dialog onSave={cb}
          // />)`) is not what it checked.
          if (executedAt(call) > observationAt(assertion)) continue;

          // Of what a render returns, only output counts: the container, or a query that runs.
          if (rendersOutput(call) && testingLibraryResult(call) && !renderOutputRead(identifier, checker))
            continue;

          // A query of a render result searches the whole page, which may hold what the test wrote there itself.
          if (
            rendersOutput(call) &&
            calls.some((entry) => entry.node === call && entry.target.rendered === true) &&
            queryAfterWrite(renderMember(identifier, checker), identifier.getStart())
          )
            continue;
          asserted.add(call);
          mergeKeys(assertedKeys, call, keysRead(value, call));
          // Read from the render result itself (`const { getByText } = render(…)`), not from a mock handed to it.
          const initializer = variableInitializer(valueSymbol(identifier, checker)?.valueDeclaration);
          const fromResult =
            rendersOutput(call) &&
            initializer !== undefined &&
            (initializer === call || contains(initializer, call));
          (fromResult ? outputReads : otherReads).add(call);
        }

      for (const { node } of calls)
        if (
          contains(value, node) &&
          evaluated(node) &&
          !excluded.has(node) &&
          // `expect(render(<Dialog />).unmount)` reads the render's API, not its output.
          !(rendersOutput(node) && testingLibraryResult(node) && !inlineOutputRead(node, checker))
        ) {
          asserted.add(node);
          mergeKeys(assertedKeys, node, keysRead(value, node));
          (rendersOutput(node) ? outputReads : otherReads).add(node);
        }

      // `const block = () => parse(x); expect(block).toThrow()`: a throw matcher runs the local function, so what
      // it calls is checked as if written inline. Other matchers only compare the function as a value.
      const local = runsSubject ? localFunction(skipParens(value), checker) : undefined;

      if (local) for (const { node } of calls) if (contains(local, node)) asserted.add(node);
    }
  }
  // `const before = Date.now(); await sleep(1000); const after = Date.now(); expect(after - before)…`: an
  // assertion comparing clock readings taken before and after awaiting a project call checks how long it took.
  const clocks = new Map<ts.Symbol, number>();

  for (const node of descendants(body))
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isClockReading(node.initializer) &&
      !inNestedFunction(node, body)
    ) {
      const symbol = checker.getSymbolAtLocation(node.name);

      if (symbol) clocks.set(symbol, node.getEnd());
    }
  const awaited = descendants(body).filter(
    (node): node is ts.AwaitExpression => ts.isAwaitExpression(node) && !inNestedFunction(node, body),
  );

  for (const value of clocks.size >= 2 ? assertions.map(comparedValues) : []) {
    const readings = value
      .flatMap((expression) => [expression, ...descendants(expression)])
      .filter(ts.isIdentifier)
      .map((identifier) => clocks.get(checker.getSymbolAtLocation(identifier) as ts.Symbol))
      .filter((position): position is number => position !== undefined);
    const first = Math.min(...readings);
    const last = Math.max(...readings);

    for (const node of awaited)
      if (first < node.getStart() && node.getEnd() < last)
        for (const call of sourcesOf([node.expression])) asserted.add(call);
  }
  // A value passed to a test helper that asserts on that parameter is asserted too. The helper is resolved
  // through the checker, so a shadowing local of the same name is not mistaken for it, and an imported helper
  // (through any re-exports) is looked up in the file that declares it.
  for (const node of descendants(body)) {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) continue;
    let symbol = checker.getSymbolAtLocation(node.expression);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const positions = (symbol?.declarations ?? [])
      .filter((declaration) => isTestCodeFile(declaration.getSourceFile(), ctx))
      .map((declaration) => assertingHelpers(declaration.getSourceFile()).get(declaration))
      .find(Boolean);
    for (const index of positions ?? []) {
      const argument = node.arguments[index];
      if (!argument) continue;
      for (const call of trackedCalls(argument)) asserted.add(call);
      for (const { node: call } of calls) if (contains(argument, call)) asserted.add(call);
    }
  }
  // A rendered component is observed by a Testing Library query of the document after it rendered
  // (`render(<Dialog />); expect(screen.getByText('Save'))…`), and a project call that a helper handed a mock to is
  // observed by an assertion on that mock (`renderDialog(); expect(onSave).toHaveBeenCalled()`).
  const observed: BodyAnalysis['observed'] = new Set();
  const reachedBy: BodyAnalysis['reached'] = new Map();
  const noteReached = (entry: BodyAnalysis['calls'][number], label: string) => {
    const labels = reachedBy.get(entry) ?? new Set<string>();
    labels.add(label);
    reachedBy.set(entry, labels);
  };
  // What the test itself, or a helper of the test code it calls, uses: then it may have made the calls or writes.
  let testReach: Reach | undefined;
  const testUses = (route: Route): boolean => {
    testReach ??= testSideReach(body, ctx);

    return routeReached(route, testReach);
  };

  // `document.body.className = 'dark'`: what the test writes to the page itself is not what a component rendered.
  for (const assertion of assertions) {
    const reached = reaches.get(assertion) as ReturnType<typeof assertionReach>;

    // Where the page was read: a query kept in a local before the render (`const before = screen.queryByText('x');
    // render(<Dialog />); expect(before)…`) did not see what rendered after it.
    documentChecks.push(...reached.documentReads);

    for (const root of reached.mockRoots) {
      if (isSelfCalled(root)) continue;
      const results = new Set(trackedCalls(root.identifier));

      for (const entry of calls)
        if (
          // The mock is read after it was handed over, as a page read must come after the render.
          executedAt(entry.node) <= root.at &&
          (entry.target.observedBy?.some((given) => covers(given, root)) ||
            mockHolders.get(entry.node)?.some((given) => covers(given, root)) ||
            (entry.target.returnsMocks &&
              results.has(entry.node) &&
              keysMatch(keysRead(root.identifier, entry.node), entry.target)))
        )
          observed.add(entry);
      // How project code could reach the mock without being handed it: through a module the file mocks or a global
      // (see `mockRoutes`). That it can is not that the assertion checks what it did, so it is recorded apart.
      const routes = mockRoutes(root, ctx).filter((route) => !testUses(route));

      if (routes.length === 0) continue;

      for (const entry of calls) {
        if (observed.has(entry) || executedAt(entry.node) > root.at) continue;
        const reach = projectReach(entry.target.symbol, ctx);

        for (const route of routes) if (routeReached(route, reach)) noteReached(entry, route.label);
      }
    }
  }

  for (const entry of calls)
    if (
      entry.target.rendered &&
      !entry.target.passThrough &&
      documentChecks.some((position) => executedAt(entry.node) < position)
    )
      observed.add(entry);

  // A read of the page after a project call whose code reads the global `document` may read what that call wrote
  // (`applyTheme('dark'); expect(document.documentElement.dataset.theme)…`). Recorded apart, as above; not when the
  // test or a helper it calls uses `document` itself, which may have written what is read.
  if (documentChecks.length > 0 && !testUses({ kind: 'global', name: 'document', label: '' }))
    for (const entry of calls)
      if (
        !observed.has(entry) &&
        !entry.target.rendered &&
        !entry.target.deferred &&
        documentChecks.some((position) => executedAt(entry.node) < position) &&
        projectReach(entry.target.symbol, ctx).globals.has('document')
      )
        noteReached(entry, 'the page, through the global document');
  const awaitedProject = awaited.filter((node) => sourcesOf([node.expression]).length > 0);
  const checks = assertions.filter(
    (assertion) => !isAssertionCountCall(assertion) && !isTypeLevelAssertion(assertion),
  );
  const progressOnly =
    asserted.size === 0 &&
    awaitedProject.length > 0 &&
    checks.length > 0 &&
    recordsProgress(checks, body, Math.min(...awaitedProject.map((node) => node.getEnd())), checker);

  // What each returned property carries: the calls its value comes from and the calls handed the mocks it holds.
  const returnedKeys: BodyAnalysis['returnedKeys'] = new Map();
  const noteReturned = (expression: ts.Expression, key: string | null) => {
    const carried = new Set(sourcesOf([expression]));

    for (const item of [expression, ...descendants(expression)]) {
      if (!ts.isIdentifier(item)) continue;
      const symbol = valueSymbol(item, checker);

      for (const [call, given] of mockHolders)
        if (given.some((reference) => reference.symbol === symbol)) carried.add(call);
    }

    for (const call of carried) mergeKeys(returnedKeys, call, key === null ? null : new Set([key]));
  };

  for (const expression of ts.isBlock(body)
    ? returnedExpressions(body)
    : ts.isExpression(body)
      ? [body]
      : []) {
    const value = skipParens(expression);

    if (!ts.isObjectLiteralExpression(value)) {
      noteReturned(expression, null);
      continue;
    }

    for (const property of value.properties) {
      const name =
        property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
          ? property.name.text
          : null;

      if (ts.isPropertyAssignment(property)) noteReturned(property.initializer, name);
      else if (ts.isShorthandPropertyAssignment(property)) noteReturned(property.name, property.name.text);
      else if (ts.isSpreadAssignment(property)) noteReturned(property.expression, null);
    }
  }

  return {
    outputOnly: new Set([...outputReads].filter((call) => !otherReads.has(call))),
    returnedKeys,
    assertedKeys,
    calls,
    assertions,
    asserted,
    unresolvedImports,
    helperAsserts,
    opaque,
    returned,
    progressOnly,
    observed,
    reached: reachedBy,
    handed,
    mockHolders,
    observesDocument: documentChecks.length > 0,
  };
}

/** Matchers that check how a mock was called or what it returned. */
const MOCK_MATCHER =
  /^(?:toHaveBeenCalled|toBeCalled|toHaveBeenLastCalledWith|toHaveBeenNthCalledWith|lastCalledWith|nthCalledWith|toHaveReturned|toReturn|toHaveLastReturned|toHaveNthReturned)/;

/**
 * What an assertion reads, through local variables of its file: where it reads the rendered page through a Testing
 * Library query or the global `document` (`const button = screen.getByRole('button'); expect(button)…`), and the
 * mocks whose calls it checks (`expect(props.onSave).toHaveBeenCalled()`, `const calls = onSave.mock.calls`).
 * A read kept in a local happens where the local is set, unless it sits in a function, which runs when called.
 * Reads of what the test wrote to the page itself (`documentWrites`, before the read) do not count.
 */
function assertionReach(
  assertion: ts.CallExpression,
  checker: ts.TypeChecker,
  documentWrites: DocumentWrite[] = [],
  // Where the assertion runs: its end, or where the local function or callback holding it is called.
  assertionAt = assertion.getEnd(),
): { documentReads: number[]; mockRoots: (MockReference & { identifier: ts.Identifier; at: number })[] } {
  const seen = new Set<ts.Symbol>();
  const mockRoots: (MockReference & { identifier: ts.Identifier; at: number })[] = [];
  const documentReads: number[] = [];
  // `const onSave = props.onSave; expect(onSave)…` reads the mock of `props`.
  const addRoot = (expression: ts.Expression, below: string[], depth: number, at = assertionAt) => {
    const path: string[] = [];
    let current = skipParens(expression);

    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const name = memberName(current);

      // A computed member (`mocks[key]`) could be any of them: only the whole object covers it.
      if (name === undefined) path.length = 0;
      else path.unshift(name);
      current = skipParens(current.expression);
    }

    if (!ts.isIdentifier(current)) return;
    const symbol = valueSymbol(current, checker);

    if (!symbol) return;
    mockRoots.push({ identifier: current, symbol, path: [...path, ...below], at });
    const declaration = symbol.valueDeclaration;
    const initializer = variableInitializer(declaration);
    // `const { onSave } = props` reads `props.onSave`.
    const property =
      declaration && ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)
        ? (declaration.propertyName ?? declaration.name)
        : undefined;
    const member = property && ts.isIdentifier(property) ? [property.text] : [];

    if (initializer && depth < 5 && initializer.getSourceFile() === assertion.getSourceFile())
      addRoot(initializer, [...member, ...path, ...below], depth + 1, at);
  };
  // Local functions the compared values call (`const read = () => screen.getByText('x'); expect(read())`).
  const executed = new Set<ts.Node>();
  // Local functions whose body is followed from a call in the compared values.
  const positioned = new Set<ts.Node>();
  const visit = (node: ts.Node, depth: number, position: number) => {
    for (const item of [node, ...descendants(node)]) {
      const caller =
        ts.isIdentifier(item) && ts.isCallExpression(item.parent) && item.parent.expression === item;
      // Every function between it and the compared value must run (`expect(() => [1].map(() => query()))` runs
      // nothing, though `map` would run its callback).
      const runs = item === node || runsWithin(item, node, assertion, executed);

      // A call in a function the assertion never runs (`expect(() => query())`) runs nothing.
      if (caller && runs) {
        const fn = localFunction(item as ts.Identifier, checker);

        if (fn) executed.add(fn);

        // A called local function reads the page where it is called (`const before = query(); render(…)`): its body
        // is followed from that call, not from where it is written.
        if (fn && isFunctionLike(fn) && fn.body && !positioned.has(fn) && depth < 20) {
          positioned.add(fn);
          const owner = item === node ? undefined : enclosingFunction(item, node);
          visit(fn.body, depth + 1, owner ? assertionAt : position);
        }
      }

      if ((ts.isCallExpression(item) && isDocumentQuery(item, checker)) || isDocumentRead(item, checker)) {
        const fn = item === node ? undefined : enclosingFunction(item, node);

        // Followed from the call that runs it, with that call's position.
        if (fn && positioned.has(fn)) continue;

        // A query in a function reads the page only when that function runs (`expect(() => screen.getByText('x'))`
        // compares a function and runs nothing).
        if (!runs) continue;
        const at = fn ? assertionAt : position;
        const chain = documentChain(item as ts.Expression, checker, true);
        const written = documentWrites.some(
          (write) =>
            write.end < at &&
            ((write.content && !(write.empty && isTextQuery(item))) ||
              (chain !== undefined && (chain === write.chain || chain.startsWith(`${write.chain}.`)))),
        );

        if (!written) documentReads.push(at);
      }

      if (ts.isPropertyAccessExpression(item) && item.name.text === 'mock') {
        const fn = item === node ? undefined : enclosingFunction(item, node);

        // Like a page query, a mock read in a function counts only when that function runs.
        // Read where the reading code runs (`const before = cb.mock.calls.length` before a render reads nothing of it).
        if (!fn || runs) addRoot(item.expression, [], 0, fn ? assertionAt : position);
      }

      if (!ts.isIdentifier(item)) continue;
      // A name in a function the assertion never runs (`expect(() => value)`) is not read.
      if (!runs) continue;
      const symbol = valueSymbol(item, checker);

      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      const initializer = variableInitializer(symbol.valueDeclaration);

      if (initializer && depth < 20 && initializer.getSourceFile() === node.getSourceFile()) {
        // `const body = document.body` holds the live element: it is read where the name is used. A value captured
        // from the page (`const before = screen.queryByText('x')`, `document.body.textContent`) is read where set.
        const chain = documentChain(initializer, checker);
        const live = chain === 'document.body' || chain === 'document.documentElement';
        const usedAt = item === node || !enclosingFunction(item, node) ? position : assertionAt;

        visit(initializer, depth + 1, live ? usedAt : initializer.getEnd());
      }
    }
  };

  for (const value of comparedValues(assertion)) visit(value, 0, assertionAt);
  const subject = assertion.arguments[0];

  if (
    subject &&
    !isFunctionLike(skipParens(subject)) &&
    isExpectCall(assertion) &&
    matcherNames(assertion).some((name) => MOCK_MATCHER.test(name))
  )
    addRoot(subject, [], 0);

  return { documentReads, mockRoots };
}

/**
 * Whether evaluating `root` in an assertion runs `node`: every function between them is run (see `runsFunction`):
 * `expect([1, 2].map((n) => compute(n)))` runs `compute`, `expect(() => onSave.mock.calls)` runs nothing.
 */
function runsWithin(
  node: ts.Node,
  root: ts.Node,
  assertion: ts.CallExpression,
  executed: Set<ts.Node> = new Set(),
): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (isFunctionLike(current) && !runsFunction(current, assertion, executed)) return false;

    if (current === root) return true;
  }

  return true;
}

/** Members of a render result that are its API, not its output: comparing them checks nothing rendered. */
const RENDER_API = new Set(['unmount', 'rerender', 'debug']);

/**
 * Whether reading `identifier` reads a render result's output: `container`, `baseElement`, the result itself (or a
 * member not known as API), and queries (`getByText`, `asFragment`) only when called.
 */
/** The member of a render result a local reads (see `renderOutputRead`), if any. */
function renderMember(identifier: ts.Identifier, checker: ts.TypeChecker): string | undefined {
  const declaration = checker.getSymbolAtLocation(identifier)?.valueDeclaration;
  const destructured =
    declaration && ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)
      ? (declaration.propertyName ?? declaration.name)
      : undefined;

  return destructured && ts.isIdentifier(destructured) ? destructured.text : memberPath(identifier)[0];
}

/**
 * Whether an inline render call is read for its output: `render(<Dialog />).container` and called queries are,
 * `render(<Dialog />).unmount` or an uncalled `render(<Dialog />).getByText` are not.
 */
function inlineOutputRead(node: Invocation, checker: ts.TypeChecker): boolean {
  let current: ts.Node = isJsxInvocation(node)
    ? jsxTop(ts.isJsxOpeningElement(node) ? node.parent : node, checker)
    : node;

  if (isJsxInvocation(node) && (ts.isCallExpression(current.parent) || ts.isNewExpression(current.parent)))
    current = current.parent;

  while (ts.isParenthesizedExpression(current.parent) || ts.isAwaitExpression(current.parent))
    current = current.parent;
  const access = current.parent;

  if (!ts.isPropertyAccessExpression(access) || access.expression !== current) return true;
  const member = access.name.text;

  if (RENDER_API.has(member)) return false;

  if (DOCUMENT_QUERY.test(member) || member === 'asFragment')
    return ts.isCallExpression(access.parent) && access.parent.expression === access;

  return true;
}

function renderOutputRead(identifier: ts.Identifier, checker: ts.TypeChecker): boolean {
  // The member a local stands for: destructured (`const { unmount } = render(…)`), or through an alias of one
  // (`const saved = unmount`, `const saved = view.unmount`).
  const memberOf = (name: ts.Identifier, depth: number): string | undefined => {
    const declaration = checker.getSymbolAtLocation(name)?.valueDeclaration;

    if (declaration && ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
      const property = declaration.propertyName ?? declaration.name;

      return ts.isIdentifier(property) ? property.text : undefined;
    }
    const initializer =
      declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
    const value = initializer && skipParens(initializer);

    if (!value || depth > 5) return undefined;

    if (ts.isIdentifier(value)) return memberOf(value, depth + 1);

    return ts.isPropertyAccessExpression(value) ? value.name.text : undefined;
  };
  const destructured = memberOf(identifier, 0);
  const member = destructured ?? memberPath(identifier)[0];

  if (member === undefined) return true;

  if (RENDER_API.has(member)) return false;

  if (DOCUMENT_QUERY.test(member) || member === 'asFragment') {
    // The value read: the identifier itself when destructured, `result.getByText` otherwise.
    const read: ts.Node = destructured ? identifier : identifier.parent;

    return ts.isCallExpression(read.parent) && read.parent.expression === read;
  }

  return true;
}

/**
 * Where code in a body runs: where it is written, or, inside functions nested in the body, where the outermost of
 * them is called (by name, as a callback, or where written). A local function nothing in the body calls never runs.
 */
function invokedAt(node: ts.Node, body: ts.Node, checker: ts.TypeChecker): number {
  let position = node.getStart();

  for (let current = node.parent; current && current !== body; current = current.parent) {
    if (!isFunctionLike(current)) continue;
    let fn: ts.Node = current;

    while (ts.isParenthesizedExpression(fn.parent)) fn = fn.parent;
    const parent = fn.parent;

    if (
      (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
      (parent.expression === fn || parent.arguments?.includes(fn as ts.Expression))
    ) {
      position = parent.getStart();
      continue;
    }
    const name = ts.isFunctionDeclaration(current)
      ? current.name
      : ts.isVariableDeclaration(parent) && parent.initializer === fn && ts.isIdentifier(parent.name)
        ? parent.name
        : undefined;
    const symbol = name && checker.getSymbolAtLocation(name);
    const calls = (symbol ? referencesOf(symbol, body.getSourceFile(), checker) : [])
      .filter(
        (item) =>
          item !== name &&
          contains(body, item) &&
          ts.isCallExpression(item.parent) &&
          item.parent.expression === item,
      )
      .map((item) => item.getStart());

    position = calls.length > 0 ? Math.min(...calls) : Number.POSITIVE_INFINITY;
  }

  return position;
}

/** The innermost function between `node` and `root` that encloses `node`, if any. */
function enclosingFunction(node: ts.Node, root: ts.Node): ts.Node | undefined {
  for (let current = node.parent; current && current !== root; current = current.parent)
    if (isFunctionLike(current)) return current;

  return isFunctionLike(root) ? root : undefined;
}

/**
 * Whether an assertion runs a function: it is called where it is written or by a compared value (`executed`), or
 * given to a call that may run it (`waitFor`, `act`, `then`, `map`, `filter`, any other callback). A function that is
 * itself a compared value, the subject of `expect` or an argument of a matcher, is only compared and does not run,
 * except as the subject of a throw matcher.
 */
function runsFunction(fn: ts.Node, assertion: ts.CallExpression, executed: Set<ts.Node>): boolean {
  if (executed.has(fn)) return true;
  let current: ts.Node = fn;

  while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
  const parent = current.parent;

  if (ts.isCallExpression(parent) && parent.expression === current) return true;

  if (
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    parent.arguments?.includes(current as ts.Expression)
  ) {
    if (parent === assertion) return runsCallback(assertion);

    // `expect(x).toEqual(() => …)`: a matcher argument is compared, not run; a predicate matcher runs it
    // (`expect(x).to.satisfy((v) => …)`, jest-extended's `toSatisfy`).
    if (ts.isCallExpression(parent) && isAssertionChainCall(parent))
      return (
        ts.isPropertyAccessExpression(parent.expression) &&
        PREDICATE_MATCHERS.has(parent.expression.name.text)
      );

    return true;
  }

  return false;
}

/** Matchers that call the predicate they are given with the value under test. */
const PREDICATE_MATCHERS = new Set(['satisfy', 'satisfies', 'toSatisfy', 'toSatisfyAll', 'toSatisfyAny']);

/** Assertion methods that run the function they are given: `assert.throws(fn)`, AVA's `t.throws(fn)` and the like. */
const RUNNING_ASSERTIONS = new Set([
  'throws',
  'rejects',
  'doesNotThrow',
  'doesNotReject',
  'throwsAsync',
  'notThrows',
  'notThrowsAsync',
]);

/**
 * Whether an assertion runs the function it is given: a throw matcher (`expect(fn).toThrow()`, chai's
 * `expect(fn).to.throw()`), or an assert method that calls it (`assert.throws(fn, /bad/)`).
 */
function runsCallback(assertion: ts.CallExpression): boolean {
  if (
    matcherNames(assertion).some(
      (name) => name.startsWith('toThrow') || name === 'throw' || name === 'throws',
    )
  )
    return true;
  const callee = skipParens(assertion.expression);

  return ts.isPropertyAccessExpression(callee) && RUNNING_ASSERTIONS.has(callee.name.text);
}

/** The name of a member access: `a.b` and `a['b']` name `b`; a computed `a[key]` names none. */
function memberName(access: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  if (ts.isPropertyAccessExpression(access)) return access.name.text;
  const argument = access.argumentExpression;

  return ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument) ? argument.text : undefined;
}

/** The variable and property path a callee or assertion subject names (`onSave`, `props.onSave`), if plain. */
function mockReference(expression: ts.Expression, checker: ts.TypeChecker): MockReference | undefined {
  const path: string[] = [];
  let current = skipParens(expression);

  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    const name = memberName(current);

    if (name === undefined) return undefined;
    path.unshift(name);
    current = skipParens(current.expression);
  }

  if (!ts.isIdentifier(current)) return undefined;
  const symbol = valueSymbol(current, checker);

  return symbol ? { symbol, path } : undefined;
}

/**
 * The member chain of the global `document` an expression reads or writes (`document.body.className`), without
 * spaces. With `outermost`, the chain is extended over the accesses made on the expression.
 */
function documentChain(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  outermost = false,
): string | undefined {
  let top: ts.Node = expression;

  while (
    outermost &&
    (ts.isPropertyAccessExpression(top.parent) || ts.isElementAccessExpression(top.parent)) &&
    top.parent.expression === top
  )
    top = top.parent;
  let root: ts.Expression = skipParens(top as ts.Expression);

  while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root))
    root = skipParens(root.expression);

  if (!ts.isIdentifier(root)) return undefined;
  const rest = top.getText().replace(/\s+/g, '').slice(root.text.length);
  const base = documentBase(root, checker, 0);

  // The bare global `document` names no member of the page.
  return base === undefined || (base === 'document' && rest === '') ? undefined : base + rest;
}

/**
 * The `document` chain an identifier stands for: the global `document`, or a local holding part of it (`const body =
 * document.body`, `const { body } = document`).
 */
function documentBase(identifier: ts.Identifier, checker: ts.TypeChecker, depth: number): string | undefined {
  const symbol = checker.getSymbolAtLocation(identifier);
  const declarations = symbol?.declarations ?? [];

  if (identifier.text === 'document' && declarations.every((item) => item.getSourceFile().isDeclarationFile))
    return 'document';
  const declaration = symbol?.valueDeclaration;

  if (!declaration || depth > 3) return undefined;

  if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name) && declaration.initializer)
    return (
      documentChain(declaration.initializer, checker) ?? documentRoot(declaration.initializer, checker, depth)
    );

  if (
    ts.isBindingElement(declaration) &&
    ts.isObjectBindingPattern(declaration.parent) &&
    !declaration.dotDotDotToken
  ) {
    const holder = declaration.parent.parent;
    const property = declaration.propertyName ?? declaration.name;

    if (!ts.isVariableDeclaration(holder) || !holder.initializer || !ts.isIdentifier(property))
      return undefined;
    const base =
      documentChain(holder.initializer, checker) ?? documentRoot(holder.initializer, checker, depth);

    return base === undefined ? undefined : `${base}.${property.text}`;
  }

  return undefined;
}

/** `document` itself (or a local holding it) as an initializer. */
function documentRoot(expression: ts.Expression, checker: ts.TypeChecker, depth: number): string | undefined {
  const value = skipParens(expression);

  return ts.isIdentifier(value) ? documentBase(value, checker, depth + 1) : undefined;
}

/**
 * The write to the page a node makes, if any: an assignment to a `document` member, or content put into one
 * (`innerHTML`, `appendChild`, …). `scope` is the code that may fill an element it appends.
 */
function documentWriteOf(node: ts.Node, scope: ts.Node, checker: ts.TypeChecker): DocumentWrite | undefined {
  let written: ts.Expression | undefined;
  let content = false;

  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    content = ts.isPropertyAccessExpression(node.left) && CONTENT_PROPERTIES.has(node.left.name.text);
    written = content && ts.isPropertyAccessExpression(node.left) ? node.left.expression : node.left;
  } else if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    CONTENT_METHODS.has(node.expression.name.text)
  ) {
    content = true;
    written = node.expression.expression;
  }
  const chain = written && documentChain(written, checker);

  if (!chain) return undefined;
  // `document.body.appendChild(anchor)` with `anchor = document.createElement('button')` the test never fills: an
  // empty element no text query can find, though a query by role or structure can.
  const empty =
    content &&
    ts.isCallExpression(node) &&
    node.arguments.length === 1 &&
    emptyElement(node.arguments[0], scope, checker);

  return { chain, end: node.getEnd(), content, empty };
}

const setupWritesCache = new WeakMap<ts.SourceFile, { node: ts.Node; scope: ts.Node }[]>();

/**
 * The writes to the page made by a file's shared setup (module or describe level, `beforeEach`/`beforeAll`) whose
 * code runs, worked out once per file; which tests they run before is decided per test.
 */
function setupWriteNodes(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
): { node: ts.Node; scope: ts.Node }[] {
  let found = setupWritesCache.get(source);

  if (!found) {
    found = descendants(source)
      .filter(
        (node) =>
          (ts.isBinaryExpression(node) || ts.isCallExpression(node)) &&
          runsBefore(node, undefined) &&
          writeRuns(node, source, checker) &&
          documentWriteOf(node, source, checker) !== undefined,
      )
      .map((node) => ({ node, scope: node }));

    // Writes of a named function registered as a hook (`beforeEach(reset)`), scoped to the registration.
    for (const hook of descendants(source))
      for (const fn of namedHook(hook, runner.setup, checker))
        for (const node of descendants(fn))
          if (!inNestedFunction(node, fn) && documentWriteOf(node, fn, checker) !== undefined)
            found.push({ node, scope: hook });
    setupWritesCache.set(source, found);
  }

  return found;
}

/** Calls that make the page fire events, so listeners given to `addEventListener` may run. */
const EVENT_SOURCES = /^(?:fireEvent|userEvent|user)$|^(?:dispatchEvent|click|focus|blur|submit)$/;

/**
 * Whether code in a test body runs: every function between it and the body is called (where written, or by name in
 * the body), or given to a call other than `expect`. A listener given to `addEventListener` runs only if the body
 * makes events fire (`fireEvent`, `userEvent`, `dispatchEvent`, `click()`).
 */
function writeRuns(
  node: ts.Node,
  body: ts.Node,
  checker: ts.TypeChecker,
  running: ReadonlySet<ts.Node> = new Set(),
  exportsRun = false,
  following: Set<ts.Node> = new Set(),
): boolean {
  for (let current = node.parent; current && current !== body; current = current.parent) {
    if (!isFunctionLike(current)) continue;

    // A function whose callers are being followed (a cycle) is not shown to run by them.
    if (following.has(current)) return false;

    // Known to run: a helper the test calls, whose code is being followed.
    if (running.has(current)) return true;
    let fn: ts.Node = current;

    while (ts.isParenthesizedExpression(fn.parent)) fn = fn.parent;
    const parent = fn.parent;

    if (ts.isCallExpression(parent) && parent.expression === fn) continue;

    if (
      (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
      parent.arguments?.includes(fn as ts.Expression)
    ) {
      if (ts.isCallExpression(parent) && isAssertionChainCall(parent)) return false;
      const callee = skipParens(parent.expression);

      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'addEventListener' &&
        !firesEvents(body)
      )
        return false;
      continue;
    }
    const name = ts.isFunctionDeclaration(current)
      ? current.name
      : ts.isVariableDeclaration(parent) && parent.initializer === fn && ts.isIdentifier(parent.name)
        ? parent.name
        : undefined;
    const symbol = name && checker.getSymbolAtLocation(name);
    const called =
      symbol !== undefined &&
      referencesOf(symbol, body.getSourceFile(), checker).some(
        (item) =>
          item !== name &&
          contains(body, item) &&
          ((ts.isCallExpression(item.parent) && item.parent.expression === item) ||
            ((ts.isCallExpression(item.parent) || ts.isNewExpression(item.parent)) &&
              item.parent.arguments?.includes(item) === true &&
              !(ts.isCallExpression(item.parent) && isAssertionChainCall(item.parent)))) &&
          // The call itself must run: not inside another function nothing calls (`function unused() { mount(); }`).
          writeRuns(item, body, checker, running, exportsRun, new Set(following).add(current as ts.Node)),
      );

    // An exported function may be called from another file, such as a shared render helper in `test-utils`.
    if (!called && !(exportsRun && name !== undefined && isExported(current, name))) return false;
  }

  return true;
}

/**
 * Whether a node sits in an inline event handler (`on*` attribute) of a DOM or third-party element while the test body
 * fires no event, so the handler never runs.
 */
function inUnfiredHandler(node: ts.Node, body: ts.Node, ctx: Ctx): boolean {
  for (let current = node.parent; current && current !== body; current = current.parent) {
    if (!isFunctionLike(current)) continue;
    let fn: ts.Node = current;

    while (ts.isParenthesizedExpression(fn.parent)) fn = fn.parent;
    const expression = fn.parent;
    const attribute = expression?.parent;

    if (
      expression &&
      ts.isJsxExpression(expression) &&
      attribute &&
      ts.isJsxAttribute(attribute) &&
      ts.isIdentifier(attribute.name) &&
      /^on[A-Z]/.test(attribute.name.text)
    ) {
      const element = attribute.parent.parent;

      if (
        resolveProjectCall(element, ctx.checker, ctx.projectSet, ctx.root) === undefined &&
        helperBody(element, ctx) === undefined &&
        !firesEvents(body)
      )
        return true;
    }
  }

  return false;
}

/** The test callback (or other function given to a call) a node sits in, where events for it would be fired. */
function eventScope(node: ts.Node): ts.Node {
  for (let current = node.parent; current; current = current.parent)
    if (
      isFunctionLike(current) &&
      ts.isCallExpression(current.parent) &&
      current.parent.arguments.includes(current as ts.Expression)
    )
      return current;

  return node.getSourceFile();
}

/**
 * Whether a function is exported from its file: `export function f`, `export const f = …`, `export default f` or
 * `export { f as g }`.
 */
function isExported(fn: ts.Node, name: ts.Identifier): boolean {
  const exportKeyword = (node: ts.Node) =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((item) => item.kind === ts.SyntaxKind.ExportKeyword);

  if (ts.isFunctionDeclaration(fn) && exportKeyword(fn)) return true;
  const statement = name.parent?.parent?.parent;

  if (statement && ts.isVariableStatement(statement) && exportKeyword(statement)) return true;

  return descendants(fn.getSourceFile()).some(
    (item) =>
      (ts.isExportSpecifier(item) &&
        (item.propertyName ?? item.name).text === name.text &&
        !item.parent.parent.moduleSpecifier) ||
      (ts.isExportAssignment(item) && ts.isIdentifier(item.expression) && item.expression.text === name.text),
  );
}

/** Whether a test body makes events fire on the page. */
function firesEvents(body: ts.Node): boolean {
  return descendants(body).some((node) => {
    if (!ts.isCallExpression(node)) return false;
    const callee = skipParens(node.expression);
    let root: ts.Expression = callee;

    while (ts.isPropertyAccessExpression(root)) root = skipParens(root.expression);

    return (
      (ts.isPropertyAccessExpression(callee) && EVENT_SOURCES.test(callee.name.text)) ||
      (ts.isIdentifier(root) && EVENT_SOURCES.test(root.text))
    );
  });
}

/** A write of the test to the page: the member chain written, where, and whether it put content there. */
interface DocumentWrite {
  chain: string;
  end: number;
  content: boolean;
  /** The content is an element the test created and left empty. */
  empty?: boolean;
}

/** Testing Library queries that match an element by its text or attributes, which an empty element has none of. */
const TEXT_QUERY = /By(?:Text|LabelText|PlaceholderText|DisplayValue|AltText|Title|TestId)$/;

function isTextQuery(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    TEXT_QUERY.test(node.expression.name.text)
  );
}

/**
 * Whether a value is a local made by `document.createElement(...)` that the body never fills: no member of it is
 * assigned and no method is called on it.
 */
function emptyElement(value: ts.Expression | undefined, body: ts.Node, checker: ts.TypeChecker): boolean {
  const local = value && skipParens(value);

  if (!local || !ts.isIdentifier(local)) return false;
  const symbol = checker.getSymbolAtLocation(local);
  const initializer = variableInitializer(symbol?.valueDeclaration);
  const created =
    initializer &&
    ts.isCallExpression(initializer) &&
    ts.isPropertyAccessExpression(initializer.expression) &&
    initializer.expression.name.text === 'createElement' &&
    ts.isIdentifier(initializer.expression.expression) &&
    initializer.expression.expression.text === 'document';

  if (!created) return false;

  return !descendants(body).some((item) => {
    if (!ts.isIdentifier(item) || checker.getSymbolAtLocation(item) !== symbol) return false;
    const access = item.parent;

    if (
      !(ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)) ||
      access.expression !== item
    )
      return false;
    const outer = access.parent;

    return (
      (ts.isCallExpression(outer) && outer.expression === access) ||
      (ts.isBinaryExpression(outer) &&
        outer.left === access &&
        outer.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        outer.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
    );
  });
}

/** Properties whose assignment replaces the content of an element. */
const CONTENT_PROPERTIES = new Set(['innerHTML', 'outerHTML', 'textContent', 'innerText']);

/** Methods that put content into an element. */
const CONTENT_METHODS = new Set([
  'appendChild',
  'append',
  'prepend',
  'insertBefore',
  'replaceChildren',
  'insertAdjacentHTML',
  'insertAdjacentElement',
]);

/** Properties of the global `document` that hold part of the rendered page. */
const DOCUMENT_PROPERTIES = new Set(['body', 'documentElement', 'activeElement']);

/** Methods of the global `document` that query the rendered page, read only when called. */
const DOCUMENT_METHODS = new Set([
  'querySelector',
  'querySelectorAll',
  'getElementById',
  'getElementsByClassName',
  'getElementsByTagName',
  'getElementsByName',
]);

/** A read of the page through the global `document` (not a local of that name), where Testing Library renders. */
function isDocumentRead(node: ts.Node, checker: ts.TypeChecker): boolean {
  if (!ts.isPropertyAccessExpression(node)) return false;
  const name = node.name.text;
  // `document.querySelector` as a value (`expect(document.querySelector).toBeTypeOf('function')`) queries nothing.
  const called = ts.isCallExpression(node.parent) && node.parent.expression === node;

  if (!DOCUMENT_PROPERTIES.has(name) && !(DOCUMENT_METHODS.has(name) && called)) return false;
  const receiver = skipParens(node.expression);

  // `document.body`, or the same through a local holding `document` (`const doc = document; doc.body`).
  return ts.isIdentifier(receiver) && documentBase(receiver, checker, 0) === 'document';
}

/** The variable an identifier names; in `{ value }` that is the variable, not the property it makes. */
function valueSymbol(identifier: ts.Identifier, checker: ts.TypeChecker): ts.Symbol | undefined {
  return ts.isShorthandPropertyAssignment(identifier.parent) && identifier.parent.name === identifier
    ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
    : checker.getSymbolAtLocation(identifier);
}

/** The initializer of the variable declaration a name or a destructured binding (`const { a } = f()`) belongs to. */
function variableInitializer(declaration: ts.Declaration | undefined): ts.Expression | undefined {
  let current: ts.Node | undefined = declaration;

  while (
    current &&
    (ts.isBindingElement(current) || ts.isObjectBindingPattern(current) || ts.isArrayBindingPattern(current))
  )
    current = current.parent;

  return current && ts.isVariableDeclaration(current) ? current.initializer : undefined;
}

/** Testing Library queries: `getByText`, `queryAllByRole`, `findByLabelText` and the like. */
const DOCUMENT_QUERY = /^(?:get|query|find)(?:All)?By[A-Z]/;

/**
 * A Testing Library query of the document: `screen.getByText(...)` or `within(element)`, with `screen` and `within`
 * imported from a `@testing-library/*` package (directly or through a local module that re-exports them).
 */
function isDocumentQuery(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
  const callee = skipParens(call.expression);

  // `const { getByText } = screen; getByText('x')`, `const find = screen.getByText; find('x')`.
  if (ts.isIdentifier(callee) && screenQueryFunction(callee, checker, 0)) return true;

  if (!ts.isPropertyAccessExpression(callee) || !DOCUMENT_QUERY.test(callee.name.text)) return false;
  const receiver = skipParens(callee.expression);

  if (testingLibraryMember(receiver, checker) === 'screen') return true;
  // A query on what `within(element)` returns, inline or kept in a local; `within(...)` alone queries nothing.
  const scoped = ts.isIdentifier(receiver)
    ? variableInitializer(valueSymbol(receiver, checker)?.valueDeclaration)
    : receiver;
  const within = scoped && skipParens(scoped);

  return (
    within !== undefined &&
    ts.isCallExpression(within) &&
    testingLibraryMember(within.expression, checker) === 'within' &&
    within.arguments[0] !== undefined &&
    fromRenderedPage(within.arguments[0], checker, 0)
  );
}

/** Whether a local holds a query of `screen`: destructured from it, taken off it, or an alias of either. */
function screenQueryFunction(identifier: ts.Identifier, checker: ts.TypeChecker, depth: number): boolean {
  const declaration = checker.getSymbolAtLocation(identifier)?.valueDeclaration;

  if (!declaration || depth > 5) return false;

  if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
    const property = declaration.propertyName ?? declaration.name;
    const holder = declaration.parent.parent;

    return (
      ts.isIdentifier(property) &&
      DOCUMENT_QUERY.test(property.text) &&
      ts.isVariableDeclaration(holder) &&
      holder.initializer !== undefined &&
      testingLibraryMember(holder.initializer, checker) === 'screen'
    );
  }
  const initializer =
    ts.isVariableDeclaration(declaration) && declaration.initializer && skipParens(declaration.initializer);

  if (!initializer) return false;

  if (ts.isIdentifier(initializer)) return screenQueryFunction(initializer, checker, depth + 1);

  return (
    ts.isPropertyAccessExpression(initializer) &&
    DOCUMENT_QUERY.test(initializer.name.text) &&
    testingLibraryMember(initializer.expression, checker) === 'screen'
  );
}

/**
 * Whether an element comes from the rendered page: a Testing Library query, a read of the global `document`, what a
 * mounting call (`render`) or a local helper returns, through local variables. A detached
 * `document.createElement(...)` or a value the test built does not.
 */
function fromRenderedPage(expression: ts.Expression, checker: ts.TypeChecker, depth: number): boolean {
  if (depth > 5) return false;

  return [expression, ...descendants(expression)].some((item) => {
    if (ts.isCallExpression(item)) {
      if (isDocumentQuery(item, checker)) return true;
      const callee = skipParens(item.expression);
      const fn = ts.isIdentifier(callee) ? localFunction(callee, checker) : undefined;

      // A local helper gives what it returns (`openDropdown()` returning a query, `renderDialog()` a render result).
      if (fn && isFunctionLike(fn) && fn.body)
        return (ts.isBlock(fn.body) ? returnedExpressions(fn.body) : [fn.body as ts.Expression]).some(
          (returned) => fromRenderedPage(returned, checker, depth + 1),
        );

      if (rendererKind(item.expression, checker) === 'document') return true;
    }

    if (isDocumentRead(item, checker)) return true;

    if (!ts.isIdentifier(item)) return false;
    const initializer = variableInitializer(valueSymbol(item, checker)?.valueDeclaration);

    return (
      initializer !== undefined &&
      initializer !== expression &&
      fromRenderedPage(initializer, checker, depth + 1)
    );
  });
}

/**
 * The `@testing-library/*` export an expression names: an imported identifier (`screen`) or a member of a namespace
 * import (`rtl.screen` with `import * as rtl from '@testing-library/react'`).
 */
function testingLibraryMember(expression: ts.Expression, checker: ts.TypeChecker): string | undefined {
  const value = skipParens(expression);

  if (ts.isIdentifier(value)) return testingLibraryExport(value, checker);

  if (!ts.isPropertyAccessExpression(value) || !ts.isIdentifier(skipParens(value.expression)))
    return undefined;
  const source = importSource(skipParens(value.expression) as ts.Identifier, checker);
  const namespace = (checker.getSymbolAtLocation(skipParens(value.expression))?.declarations ?? []).some(
    ts.isNamespaceImport,
  );

  return namespace && source?.startsWith('@testing-library/') ? value.name.text : undefined;
}

/** The name a `@testing-library/*` package exports that an identifier refers to, if it refers to one. */
function testingLibraryExport(identifier: ts.Identifier, checker: ts.TypeChecker): string | undefined {
  const symbol = checker.getSymbolAtLocation(identifier);

  for (const declaration of symbol?.declarations ?? []) {
    if (!ts.isImportSpecifier(declaration)) continue;
    const specifier = declaration.parent.parent.parent.moduleSpecifier;

    if (ts.isStringLiteral(specifier) && specifier.text.startsWith('@testing-library/'))
      return (declaration.propertyName ?? declaration.name).text;

    // Re-exported by a local module (`export * from '@testing-library/react'` in `test/utils.tsx`).
    const aliased =
      symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : undefined;

    if (
      aliased?.declarations?.some((item) => /[\\/]@testing-library[\\/]/.test(item.getSourceFile().fileName))
    )
      return aliased.getName();
  }

  return undefined;
}

/**
 * Whether the assertions compare only locals of `body` that it sets to constants, unconditionally, after `after`
 * (the end of the first awaited project call): `const values = []; await acquire(); values.push(1);
 * expect(values).toEqual([1])`. Such a record shows that the test got past the await, and nothing else.
 */
function recordsProgress(
  assertions: ts.CallExpression[],
  body: ts.Node,
  after: number,
  checker: ts.TypeChecker,
): boolean {
  const compared = assertions.flatMap(comparedValues);
  const inAssertion = (node: ts.Node) => compared.some((value) => contains(value, node) || value === node);
  const records = new Set<ts.Symbol>();

  for (const value of compared)
    for (const identifier of [value, ...descendants(value)].filter(ts.isIdentifier)) {
      // `values.length`: the property name is not a variable.
      if (ts.isPropertyAccessExpression(identifier.parent) && identifier.parent.name === identifier) continue;

      if (isCompileTimeConstant(identifier, checker)) continue;
      const symbol = checker.getSymbolAtLocation(identifier);

      if (!symbol) return false;
      records.add(symbol);
    }

  if (records.size === 0) return false;

  return [...records].every((symbol) => {
    const declaration = symbol.valueDeclaration;

    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !contains(body, declaration) ||
      inNestedFunction(declaration, body) ||
      (declaration.initializer && !isCompileTimeConstant(declaration.initializer, checker))
    )
      return false;
    let writes = 0;

    for (const node of descendants(body)) {
      if (!ts.isIdentifier(node) || node === declaration.name) continue;

      if (checker.getSymbolAtLocation(node) !== symbol || inAssertion(node)) continue;
      const statement = constantWrite(node, checker);

      // Every other use must be a constant write in a statement of the body itself, after the await.
      if (!statement || statement.parent !== body || statement.getStart() < after) return false;
      writes++;
    }

    return writes > 0;
  });
}

/**
 * The statement around `x.push(1)`, `x = 1`, `x += 1` or `x++` when `identifier` is the `x` it writes a constant
 * to.
 */
function constantWrite(
  identifier: ts.Identifier,
  checker: ts.TypeChecker,
): ts.ExpressionStatement | undefined {
  const parent = identifier.parent;
  let write: ts.Expression | undefined;

  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === identifier &&
    parent.name.text === 'push' &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent &&
    parent.parent.arguments.every((argument) => isCompileTimeConstant(argument, checker))
  )
    write = parent.parent;
  else if (
    ts.isBinaryExpression(parent) &&
    parent.left === identifier &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
    isCompileTimeConstant(parent.right, checker)
  )
    write = parent;
  else if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(parent.operator)
  )
    write = parent;

  return write && ts.isExpressionStatement(write.parent) ? write.parent : undefined;
}

/** `Date.now()`, `performance.now()` or `new Date()`: a reading of the clock. */
function isClockReading(expression: ts.Expression): boolean {
  const value = skipParens(expression);

  if (ts.isNewExpression(value))
    return ts.isIdentifier(value.expression) && value.expression.text === 'Date' && !value.arguments?.length;

  return (
    ts.isCallExpression(value) &&
    value.arguments.length === 0 &&
    ts.isPropertyAccessExpression(value.expression) &&
    value.expression.name.text === 'now' &&
    ts.isIdentifier(value.expression.expression) &&
    ['Date', 'performance'].includes(value.expression.expression.text)
  );
}

/** Whether a node sits in a function nested in `body`, which runs at another time than `body` itself. */
function inNestedFunction(node: ts.Node, body: ts.Node): boolean {
  for (let current = node.parent; current && current !== body; current = current.parent)
    if (isFunctionLike(current)) return true;

  return false;
}

/** Promise methods whose callbacks run with the settled result of what they are called on. */
const CONTINUATIONS = new Set(['then', 'catch', 'finally']);

/**
 * The project symbols a call reaches: directly, through a function defined in test code, or as a method of a
 * project value (`Schema.parse(x)` exercises the project's `Schema`).
 */
function callInfo(node: Invocation, ctx: Ctx): CallInfo {
  const cached = ctx.callInfo.get(node);

  if (cached) return cached;
  const none: CallInfo = { targets: [], helperAsserts: false, opaque: false };
  const direct = resolveProjectCall(node, ctx.checker, ctx.projectSet, ctx.root);
  let info: CallInfo;

  // A JSX element renders the component its tag names once it is mounted: what that component (or a local component
  // of the test file and whatever it calls) produces is in the document. An element that is only created
  // (`expect(<Dialog />).toBeTruthy()`, `const unused = <Dialog />`) runs nothing.
  // Server rendering (`renderToString(<Dialog />)`) runs the component into the string it returns, not the document.
  const mount = isJsxInvocation(node) ? mountedJsx(node, ctx) : undefined;

  if (isJsxInvocation(node) && !mount) {
    ctx.callInfo.set(node, none);

    return none;
  }
  const rendered = mount === 'document';
  const deferred = mount === 'returned';
  const passThrough = rendered && isJsxInvocation(node) && suppliesOnlyForeignChildren(node, ctx);

  if (direct)
    info = {
      ...none,
      targets: [
        {
          symbol: direct,
          ownArgs: true,
          assertedInside: false,
          flowsToResult: true,
          rendered,
          passThrough,
          ...(deferred ? { deferred } : {}),
        },
      ],
    };
  else {
    const helper = helperBody(node, ctx);
    const receiver = helper ? undefined : projectReceiver(node, ctx);

    if (helper) {
      info = helperInfo(helper, ctx);

      // What a local component renders is what it returns: calls whose result does not reach that are not shown.
      if (mount)
        info = {
          ...info,
          targets: info.targets.map((target) => ({
            ...target,
            rendered: rendered && target.flowsToResult,
            deferred: deferred && target.flowsToResult,
          })),
        };
      // A call of a factory (`make()`): what it returns as JSX is rendered only if this call's result is mounted.
      else if (info.targets.some((target) => target.deferred)) {
        const result = mountedExpression(node, ctx, 0);

        info = {
          ...info,
          targets: info.targets.flatMap((target) =>
            !target.deferred
              ? [target]
              : !result
                ? []
                : result === 'returned'
                  ? [target]
                  : [{ ...target, deferred: false, rendered: result === 'document' }],
          ),
        };
      }
    } else if (receiver)
      info = {
        ...none,
        targets: [{ symbol: receiver, ownArgs: false, assertedInside: false, flowsToResult: true, rendered }],
      };
    else
      info = {
        ...none,
        opaque:
          !ts.isTaggedTemplateExpression(node) && !isJsxInvocation(node) && isOpaqueCall(node, ctx.checker),
      };
  }
  const known = new Set(info.targets.map((t) => t.symbol));
  // Built-ins such as `map` and test helpers call the functions they are given. Project code is followed into:
  // a function it only stores (`registry.push(fn)`) is not counted as called.
  const projectReceives =
    info.targets.some((t) => t.ownArgs) || (!direct && projectReceiver(node, ctx) !== undefined);
  const passed = passedProjectFunctions(node, ctx, projectReceives).filter((symbol) => !known.has(symbol));

  // `[13, 37].map(helper)`: a built-in runs a test helper it is given and hands back what the helper returns.
  if (info.targets.length === 0 && !(ts.isCallExpression(node) && isAssertionChainCall(node))) {
    const helpers = argumentsOf(node)
      .map((argument) => skipParens(argument))
      .filter(ts.isIdentifier)
      .map((argument) => helperBodyOf(argument, ctx))
      .filter((body): body is ts.Node => body !== undefined);

    if (helpers.length > 0) {
      const followed = helpers.map((body) => helperInfo(body, ctx));
      info = {
        targets: followed.flatMap((helper) => helper.targets),
        helperAsserts: info.helperAsserts || followed.some((helper) => helper.helperAsserts),
        opaque: info.opaque || followed.some((helper) => helper.opaque),
      };
    }
  }

  if (passed.length > 0)
    info = {
      ...info,
      targets: [
        ...info.targets,
        ...passed.map((symbol) => ({ symbol, ownArgs: false, assertedInside: false, flowsToResult: true })),
      ],
    };
  ctx.callInfo.set(node, info);

  return info;
}

/**
 * Whether a render is given a `container` option that is not part of the page: an element the test creates and does
 * not append to the document, or any value not shown to come from it.
 */
function detachedContainer(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
  // The options object: written inline, held in a local (`const options = { container }`), or spread into one.
  const containerOf = (
    expression: ts.Expression | undefined,
    depth: number,
  ): ts.Expression | null | undefined => {
    let options = expression && skipParens(expression);

    if (options && ts.isIdentifier(options))
      options = variableInitializer(valueSymbol(options, checker)?.valueDeclaration) ?? options;

    if (!options || !ts.isObjectLiteralExpression(options) || depth > 3) return undefined;
    let found: ts.Expression | null | undefined;

    for (const property of options.properties) {
      if (ts.isSpreadAssignment(property)) {
        const inner = containerOf(property.expression, depth + 1);

        if (inner !== undefined) found = inner;
      } else if (property.name && ts.isIdentifier(property.name) && property.name.text === 'container')
        found = ts.isPropertyAssignment(property)
          ? skipParens(property.initializer)
          : ts.isShorthandPropertyAssignment(property)
            ? property.name
            : null;
    }

    return found;
  };
  const value = containerOf(call.arguments[1], 0);

  // No container given: Testing Library appends one to the page. A container not shown to be in the page keeps the
  // output out of it.
  return value === undefined ? false : value === null || detachedNode(value, checker);
}

/** React's `createPortal`, by the name it is imported under (`createPortal`, `ReactDOM.createPortal`). */
function isCreatePortal(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  const callee = skipParens(expression);

  return ts.isIdentifier(callee)
    ? importedName(callee, checker) === 'createPortal'
    : ts.isPropertyAccessExpression(callee) && callee.name.text === 'createPortal';
}

/**
 * Whether a DOM node is not shown to be part of the page: an element the test creates and does not append to the
 * document, or any value not shown to come from it.
 */
function detachedNode(node: ts.Expression, checker: ts.TypeChecker): boolean {
  const value = skipParens(node);

  if (documentChain(value, checker) !== undefined) return false;

  if (!ts.isIdentifier(value)) return true;
  const symbol = valueSymbol(value, checker);
  const initializer = variableInitializer(symbol?.valueDeclaration);

  if (initializer && documentChain(initializer, checker) !== undefined) return false;

  // Appended to the page (`document.body.appendChild(container)`).
  return !(symbol ? referencesOf(symbol, value.getSourceFile(), checker) : []).some(
    (item) =>
      ts.isCallExpression(item.parent) &&
      item.parent.arguments.includes(item) &&
      ts.isPropertyAccessExpression(item.parent.expression) &&
      CONTENT_METHODS.has(item.parent.expression.name.text) &&
      documentChain(item.parent.expression.expression, checker) !== undefined,
  );
}

/** Renderer names that other libraries use too: only taken as renderers when imported from these packages. */
const AMBIGUOUS_RENDERERS: Record<string, RegExp> = {
  mount: /^enzyme(?:$|\/)/,
  shallow: /^enzyme(?:$|\/)/,
  create: /^react-test-renderer(?:$|\/)/,
};

/**
 * What kind of renderer a callee is: `render`/`rerender`/`hydrate` draw into the page; server rendering, and
 * `create`/`shallow`/`mount` imported from react-test-renderer or Enzyme (directly or as `TestRenderer.create`), render
 * into their own output. Anything else renders nothing known.
 */
function rendererKind(expression: ts.Expression, checker: ts.TypeChecker): Mount {
  const callee = skipParens(expression);
  const identifier = ts.isIdentifier(callee)
    ? callee
    : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(skipParens(callee.expression))
      ? (skipParens(callee.expression) as ts.Identifier)
      : undefined;
  const name = ts.isIdentifier(callee)
    ? importedName(callee, checker)
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : undefined;

  if (name === undefined) return undefined;

  if (MOUNTING_FUNCTIONS.has(name)) return 'document';
  const source = identifier && importSource(identifier, checker);
  const ambiguous = AMBIGUOUS_RENDERERS[name];

  if (ambiguous) return source !== undefined && ambiguous.test(source) ? 'string' : undefined;

  return STRING_RENDERING_FUNCTIONS.has(name) ? 'string' : undefined;
}

/** The module an imported identifier comes from (`enzyme` for `import { mount } from 'enzyme'`). */
function importSource(identifier: ts.Identifier, checker: ts.TypeChecker): string | undefined {
  for (const declaration of checker.getSymbolAtLocation(identifier)?.declarations ?? []) {
    const statement = ts.isImportSpecifier(declaration)
      ? declaration.parent.parent.parent
      : ts.isNamespaceImport(declaration)
        ? declaration.parent.parent
        : ts.isImportClause(declaration)
          ? declaration.parent
          : undefined;

    if (statement && ts.isStringLiteral(statement.moduleSpecifier)) return statement.moduleSpecifier.text;
  }

  return undefined;
}

/** Whether a call runs a function whose body is visible (test code or project code), not a declaration. */
function hasFunctionBody(call: ts.CallExpression | ts.NewExpression, checker: ts.TypeChecker): boolean {
  let symbol = aliasTarget(call.expression, checker);

  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);

  return (symbol?.declarations ?? [])
    .map((item) => (ts.isVariableDeclaration(item) && item.initializer ? skipParens(item.initializer) : item))
    .some(
      (item) => isFunctionLike(item) && item.body !== undefined && !item.getSourceFile().isDeclarationFile,
    );
}

/** The name a module exports that an imported identifier stands for, or the identifier's own name. */
function importedName(identifier: ts.Identifier, checker: ts.TypeChecker): string {
  const declaration = checker.getSymbolAtLocation(identifier)?.declarations?.[0];

  return declaration && ts.isImportSpecifier(declaration)
    ? (declaration.propertyName ?? declaration.name).text
    : identifier.text;
}

const setupRendersCache = new WeakMap<ts.SourceFile, { node: Invocation; call: ts.CallExpression }[]>();

/**
 * The renders of a file's `beforeEach` hooks, worked out once per file; which tests they run before is decided per
 * test. The mounting call itself must run in the hook (`beforeEach(() => render(<Dialog />))`, `render(ui)` with a
 * `ui` element made elsewhere, or a render helper): an element only made or stored there renders nothing. Renders in
 * `beforeAll` or directly at module or describe level are left out, since Testing Library cleans the page up after
 * each test and only the first test would see them.
 */
function setupRenders(source: ts.SourceFile, ctx: Ctx): { node: Invocation; call: ts.CallExpression }[] {
  let found = setupRendersCache.get(source);

  if (!found) {
    found = [];
    const rendered = (node: Invocation) => callInfo(node, ctx).targets.some((target) => target.rendered);

    for (const call of descendants(source)) {
      if (!ts.isCallExpression(call) || !inBeforeEach(call)) continue;

      if (rendered(call)) {
        found.push({ node: call, call });
        continue;
      }
      collect(call, call);
    }

    // `beforeEach(mount)` with `function mount() { render(<Dialog />); }`: the renders of the named function, scoped
    // to the registration.
    for (const hook of descendants(source))
      for (const fn of namedHook(hook, runner.beforeEach, ctx.checker))
        for (const call of descendants(fn))
          if (ts.isCallExpression(call) && !inNestedFunction(call, fn)) {
            if (rendered(call)) found.push({ node: call, call: hook as ts.CallExpression });
            else collect(call, hook as ts.CallExpression);
          }
    setupRendersCache.set(source, found);
  }

  return found;

  function collect(call: ts.CallExpression, scope: ts.CallExpression): void {
    const rendered = (node: Invocation) => callInfo(node, ctx).targets.some((target) => target.rendered);

    for (const argument of call.arguments) {
      // Elements given to this call, inline or through a local holding them.
      const initializer = ts.isIdentifier(skipParens(argument))
        ? variableInitializer(ctx.checker.getSymbolAtLocation(skipParens(argument))?.valueDeclaration)
        : undefined;

      for (const root of initializer ? [argument, initializer] : [argument])
        for (const node of [root, ...descendants(root)])
          if (
            isJsxInvocation(node) &&
            jsxTop(ts.isJsxOpeningElement(node) ? node.parent : node, ctx.checker) === root &&
            rendered(node)
          )
            (found as { node: Invocation; call: ts.CallExpression }[]).push({ node, call: scope });
    }
  }
}

/**
 * The body of a local function registered by name with a hook (`beforeEach(mount)`), when the registration is shared
 * setup (see `runsBefore`).
 */
function namedHook(node: ts.Node, hooks: Set<string>, checker: ts.TypeChecker): ts.Node[] {
  if (
    !ts.isCallExpression(node) ||
    !ts.isIdentifier(node.expression) ||
    !hooks.has(node.expression.text) ||
    !runsBefore(node, undefined)
  )
    return [];
  const argument = node.arguments[0] && skipParens(node.arguments[0]);
  const fn = argument && ts.isIdentifier(argument) ? localFunction(argument, checker) : undefined;

  return fn && isFunctionLike(fn) && fn.body ? [fn.body] : [];
}

/** Whether code runs as shared setup inside a `beforeEach` hook (see `runsBefore`). */
function inBeforeEach(node: ts.Node): boolean {
  if (!runsBefore(node, undefined)) return false;

  for (let current = node.parent; current; current = current.parent)
    if (isFunctionLike(current) && ts.isCallExpression(current.parent)) {
      const callee = current.parent.expression;

      if (ts.isIdentifier(callee) && runner.beforeEach.has(callee.text)) return true;
    }

  return false;
}

/** Whether an expression is a JSX element (or a choice of elements), the description of what to render. */
function isElementDescription(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  return [expression, ...descendants(expression)].some(
    (item) =>
      isJsxInvocation(item) &&
      jsxTop(ts.isJsxOpeningElement(item) ? item.parent : item, checker) === expression,
  );
}

/** Functions that mount the element they are given: Testing Library, react-dom, react-test-renderer, Enzyme. */
const MOUNTING_FUNCTIONS = new Set(['render', 'rerender', 'hydrate', 'hydrateRoot']);

/**
 * Functions that run the components of an element into what they return, outside the page: server rendering to a
 * string of HTML, react-test-renderer's `create`, and Enzyme's `shallow` and `mount` (which attaches to a node of its
 * own, not the document, unless told otherwise).
 */
const STRING_RENDERING_FUNCTIONS = new Set([
  'renderToString',
  'renderToStaticMarkup',
  'create',
  'shallow',
  'mount',
]);

/**
 * How a JSX element is mounted: into the document, into the returned output of a renderer (`'string'`: server
 * rendering, a test renderer), or not at all.
 */
type Mount = 'document' | 'string' | 'returned' | undefined;

/**
 * The strongest of several ways an element may be mounted. `'returned'`: a function returns it, so it is mounted
 * wherever the result of each call of that function is, decided per call.
 */
function combineMounts(mounts: Mount[]): Mount {
  return mounts.includes('document')
    ? 'document'
    : mounts.includes('string')
      ? 'string'
      : mounts.includes('returned')
        ? 'returned'
        : undefined;
}

/** Whether an element is mounted by a renderer, as opposed to only returned or not at all. */
function isMounted(mount: Mount): boolean {
  return mount === 'document' || mount === 'string';
}

/**
 * Whether a JSX element is mounted: it (or the JSX tree it sits in) is given to a function that mounts it, to a
 * function of the test code or the project (a render helper), or is returned by a function (a component or a helper,
 * judged where that is used), directly or through a local variable that is.
 */
function mountedJsx(node: ts.JsxSelfClosingElement | ts.JsxOpeningElement, ctx: Ctx): Mount {
  const own = ts.isJsxOpeningElement(node) ? node.parent : node;
  const top = jsxTop(own, ctx.checker);

  // Enzyme's `shallow` runs only the root component: elements nested in it stay descriptions.
  if (top !== own && ts.isCallExpression(top.parent) && isShallow(top.parent.expression, ctx.checker))
    return undefined;

  return mountedExpression(own, ctx, 0);
}

/** Enzyme's `shallow`, imported from `enzyme` (`shallow(...)` or `enzyme.shallow(...)`). */
function isShallow(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  const callee = skipParens(expression);
  const identifier = ts.isIdentifier(callee)
    ? callee
    : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(skipParens(callee.expression))
      ? (skipParens(callee.expression) as ts.Identifier)
      : undefined;
  const name = ts.isIdentifier(callee)
    ? importedName(callee, checker)
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : undefined;
  const source = identifier && importSource(identifier, checker);

  return name === 'shallow' && source !== undefined && /^enzyme(?:$|\/)/.test(source);
}

/**
 * How an element given as the `index`-th argument of a helper or project function is mounted: where the function
 * hands that parameter to a renderer, directly or through further helpers. Unknown bodies mount nothing.
 */
function argumentMount(
  call: ts.CallExpression | ts.NewExpression,
  index: number,
  ctx: Ctx,
  depth: number,
  returns: ResultMounts = new Map(),
  running: ReadonlySet<ts.Node> = new Set(),
): Mount {
  if (index < 0 || depth > 5) return undefined;
  let symbol = aliasTarget(call.expression, ctx.checker);

  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = ctx.checker.getAliasedSymbol(symbol);
  const fn = (symbol?.declarations ?? [])
    .map((item) => (ts.isVariableDeclaration(item) && item.initializer ? skipParens(item.initializer) : item))
    .find(
      (item) => isFunctionLike(item) && item.body !== undefined && !item.getSourceFile().isDeclarationFile,
    );

  if (!fn || !isFunctionLike(fn) || !fn.body) return undefined;
  const parameter = fn.parameters[index];

  if (!parameter || parameter.dotDotDotToken || !ts.isIdentifier(parameter.name)) return undefined;
  const target = ctx.checker.getSymbolAtLocation(parameter.name);
  const mounts = descendants(fn.body)
    .filter((item) => ts.isIdentifier(item) && ctx.checker.getSymbolAtLocation(item) === target)
    .map((item) => mountedExpression(item, ctx, depth + 1, returns, new Set(running).add(fn)));
  const mount = combineMounts(mounts);

  // `wrap(<Dialog />)` with `wrap = (ui) => ui`: mounted where this call's result is.
  return mount === 'returned' ? mountedExpression(call, ctx, depth + 1, returns, running) : mount;
}

/** The function a JSX tag names when its code is visible (test code or project code), not a declaration. */
function componentFunction(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  checker: ts.TypeChecker,
): ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration | undefined {
  if (ts.isJsxNamespacedName(element.tagName)) return undefined;
  let symbol = aliasTarget(element.tagName as ts.Expression, checker);

  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const fn = (symbol?.declarations ?? [])
    .map((item) => (ts.isVariableDeclaration(item) && item.initializer ? skipParens(item.initializer) : item))
    .find(
      (item) => isFunctionLike(item) && item.body !== undefined && !item.getSourceFile().isDeclarationFile,
    );

  return fn && isFunctionLike(fn) ? fn : undefined;
}

/**
 * How an element given as the `name` prop of a component is mounted: where the component's own code puts that prop
 * (`function Layout({ header }) { return <main>{header}</main>; }`), judged like any other expression, and only if the
 * component itself is mounted. Components whose body is not visible (intrinsic, third-party) mount nothing.
 */
function propMount(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string,
  ctx: Ctx,
  depth: number,
  returns: ResultMounts = new Map(),
  running: ReadonlySet<ts.Node> = new Set(),
): Mount {
  const fn = componentFunction(element, ctx.checker);

  if (!fn?.body) return undefined;
  const parameter = fn.parameters[0];

  if (!parameter) return undefined;
  const reads: ts.Expression[] = [];

  if (ts.isIdentifier(parameter.name)) {
    // `props.header`
    const props = ctx.checker.getSymbolAtLocation(parameter.name);

    for (const item of descendants(fn.body))
      if (
        ts.isPropertyAccessExpression(item) &&
        item.name.text === name &&
        ts.isIdentifier(item.expression) &&
        ctx.checker.getSymbolAtLocation(item.expression) === props
      )
        reads.push(item);
  } else if (ts.isObjectBindingPattern(parameter.name)) {
    // `{ header }` or `{ header: top }`
    const binding = parameter.name.elements.find((item) => {
      const property = item.propertyName ?? item.name;

      return !item.dotDotDotToken && ts.isIdentifier(property) && property.text === name;
    });
    const local =
      binding && ts.isIdentifier(binding.name) ? ctx.checker.getSymbolAtLocation(binding.name) : undefined;

    if (local)
      for (const item of descendants(fn.body))
        if (ts.isIdentifier(item) && ctx.checker.getSymbolAtLocation(item) === local) reads.push(item);
  }
  // What the component returns is mounted exactly as this element is, so a prop it puts into its returned JSX is too.
  const elementMount =
    reads.length > 0
      ? mountedExpression(
          ts.isJsxOpeningElement(element) ? element.parent : element,
          ctx,
          depth + 1,
          returns,
          running,
        )
      : undefined;
  const inner = new Map(returns).set(fn, elementMount);
  // The component runs where its element is rendered, so its own body does not need a caller in its file.
  const mounts = reads.map((read) =>
    mountedExpression(read, ctx, depth + 1, inner, new Set(running).add(fn)),
  );

  return combineMounts(mounts);
}

/** The outermost expression of the JSX tree an element sits in, through conditionals, arrays and parentheses. */
function jsxTop(expression: ts.Node, checker: ts.TypeChecker): ts.Node {
  let current = expression;
  for (;;) {
    const parent = current.parent;

    // A prop value (`<Ignore unused={<Dialog />} />`) is handed to that component, which may not render it: it is
    // judged as an argument, not as part of the tree around it.
    if (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent)) break;

    // So are the children of a component whose code is visible (`<Ignore><Dialog /></Ignore>`); intrinsic and
    // third-party elements are taken to render their children.
    if (
      ts.isJsxElement(parent) &&
      parent.children.includes(current as ts.JsxChild) &&
      componentFunction(parent.openingElement, checker) !== undefined
    )
      break;

    if (
      ts.isJsxElement(parent) ||
      ts.isJsxFragment(parent) ||
      ts.isJsxExpression(parent) ||
      ts.isJsxAttribute(parent) ||
      ts.isJsxAttributes(parent) ||
      ts.isJsxOpeningElement(parent) ||
      ts.isJsxSelfClosingElement(parent) ||
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      (ts.isConditionalExpression(parent) && parent.condition !== current) ||
      (ts.isBinaryExpression(parent) &&
        [
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken,
        ].includes(parent.operatorToken.kind))
    ) {
      current = parent;
      continue;
    }
    break;
  }

  return current;
}

/**
 * Components whose returned JSX is known to be mounted a given way while judging one element: inside
 * `<Providers><Dialog /></Providers>` in a test, what `Providers` returns is mounted as that element is.
 */
type ResultMounts = ReadonlyMap<ts.Node, Mount>;

function mountedExpression(
  expression: ts.Node,
  ctx: Ctx,
  depth: number,
  returns: ResultMounts = new Map(),
  running: ReadonlySet<ts.Node> = new Set(),
): Mount {
  const current = jsxTop(expression, ctx.checker);
  const parent = current.parent;

  // Returned by a component or factory: mounted where what the function returns is, so only if that is.
  if (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === current)) {
    let fn: ts.Node | undefined = parent;

    while (fn && !isFunctionLike(fn)) fn = fn.parent;

    if (!fn) return undefined;

    // Mounted where each call's result is: decided at the call (`render(make())`), not by other calls in the file.
    return returns.has(fn) ? returns.get(fn) : 'returned';
  }

  if (
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    parent.arguments?.includes(current as ts.Expression)
  ) {
    const index = parent.arguments?.indexOf(current as ts.Expression) ?? -1;

    // The mounting call must run: not in a function nothing calls (`function unused() { render(<Dialog />); }`).
    // Functions reached by following a helper the test calls run; others need a caller or an export.
    if (!writeRuns(parent, parent.getSourceFile(), ctx.checker, running, true)) return undefined;

    // A helper or project function with a body (even one named `mount`): mounted only where it hands the element to
    // a renderer. Otherwise a renderer recognized by name and, for ambiguous names, by the package it comes from.
    if (hasFunctionBody(parent, ctx.checker))
      return argumentMount(parent, index, ctx, depth, returns, running);

    // `createPortal(<Dialog />, document.body)`: rendered where the portal is mounted, into its destination.
    if (ts.isCallExpression(parent) && index === 0 && isCreatePortal(parent.expression, ctx.checker)) {
      const portal = mountedExpression(parent, ctx, depth + 1, returns, running);
      const destination = parent.arguments[1];

      return portal === 'document' && destination && detachedNode(destination, ctx.checker)
        ? 'string'
        : portal;
    }
    const kind = rendererKind(parent.expression, ctx.checker);

    // `render(ui, { container: document.createElement('div') })`: a container that is not in the page keeps the
    // output out of it; what the render returns still holds it.
    return kind === 'document' && ts.isCallExpression(parent) && detachedContainer(parent, ctx.checker)
      ? 'string'
      : kind;
  }

  // `<Wrapper><Dialog /></Wrapper>`: mounted where the component renders its children.
  if (ts.isJsxElement(parent) && parent.children.includes(current as ts.JsxChild))
    return depth < 8 ? propMount(parent.openingElement, 'children', ctx, depth, returns, running) : undefined;

  // `<Layout header={<Dialog />} />`: mounted where the component renders that prop.
  if (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent)) {
    const attribute = parent.parent;
    const element = attribute.parent.parent;

    return ts.isIdentifier(attribute.name) && depth < 8
      ? propMount(element, attribute.name.text, ctx, depth, returns, running)
      : undefined;
  }

  // `const ui = <Dialog />; render(ui)`.
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === current &&
    ts.isIdentifier(parent.name) &&
    depth < 3
  ) {
    const symbol = ctx.checker.getSymbolAtLocation(parent.name);

    const mounts = (symbol ? referencesOf(symbol, parent.getSourceFile(), ctx.checker) : [])
      .filter((item) => item !== parent.name)
      .map((item) => mountedExpression(item, ctx, depth + 1, returns, running));

    return combineMounts(mounts);
  }

  return undefined;
}

const referencesCache = new WeakMap<ts.SourceFile, Map<ts.Symbol, ts.Identifier[]>>();

/** The identifiers of a file that name a symbol, indexed once per file. */
function referencesOf(symbol: ts.Symbol, source: ts.SourceFile, checker: ts.TypeChecker): ts.Identifier[] {
  let references = referencesCache.get(source);

  if (!references) {
    references = new Map();

    for (const item of descendants(source)) {
      if (!ts.isIdentifier(item)) continue;
      const named = checker.getSymbolAtLocation(item);

      if (named) {
        const list = references.get(named);

        if (list) list.push(item);
        else references.set(named, [item]);
      }
    }
    referencesCache.set(source, references);
  }

  return references.get(symbol) ?? [];
}

/**
 * Whether a rendered element's own children hold no component of the project or the test: only text, intrinsic or
 * third-party elements and values (`<Providers><Button>Go</Button></Providers>`, `<Providers>{children}</Providers>`).
 * Without children, the content is the component's own.
 */
function suppliesOnlyForeignChildren(
  node: ts.JsxSelfClosingElement | ts.JsxOpeningElement,
  ctx: Ctx,
): boolean {
  // The effective children: child nodes, a `children` attribute, or `children` in a spread object literal.
  const children: ts.Node[] = ts.isJsxOpeningElement(node)
    ? node.parent.children.filter((child) => !(ts.isJsxText(child) && child.containsOnlyTriviaWhiteSpaces))
    : [];

  for (const attribute of node.attributes.properties) {
    if (
      ts.isJsxAttribute(attribute) &&
      ts.isIdentifier(attribute.name) &&
      attribute.name.text === 'children' &&
      attribute.initializer
    )
      children.push(attribute.initializer);

    if (ts.isJsxSpreadAttribute(attribute)) {
      let value = skipParens(attribute.expression);

      if (ts.isIdentifier(value))
        value = variableInitializer(ctx.checker.getSymbolAtLocation(value)?.valueDeclaration) ?? value;

      if (ts.isObjectLiteralExpression(value))
        for (const property of value.properties)
          if (property.name && ts.isIdentifier(property.name) && property.name.text === 'children')
            children.push(property);
    }
  }

  if (children.length === 0) return false;

  return !children.some((child) =>
    [child, ...descendants(child)].some(
      (item) =>
        isJsxInvocation(item) &&
        (resolveProjectCall(item, ctx.checker, ctx.projectSet, ctx.root) !== undefined ||
          helperBody(item, ctx) !== undefined),
    ),
  );
}

/** `X.method(...)` or `X.a.b(...)` where `X` is a value declared in a project file. */
function projectReceiver(node: Invocation, ctx: Ctx): string | undefined {
  const callee = skipParens(calleeOf(node));

  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return undefined;
  let current: ts.Expression = callee;

  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current))
    current = skipParens(current.expression);

  if (!ts.isIdentifier(current)) return undefined;
  let symbol = ctx.checker.getSymbolAtLocation(current);

  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = ctx.checker.getAliasedSymbol(symbol);

  // A namespace import's members resolve directly; the module itself is not a value under test.
  if (!symbol || symbol.flags & ts.SymbolFlags.ValueModule) return undefined;

  return projectSymbolId(symbol, ctx.checker, ctx.projectSet, ctx.root);
}

/**
 * Node.js functions that run code static analysis cannot see, by module: other processes, and source text that
 * `node:vm` compiles at run time (`runInNewContext('f(1)', { f })`).
 */
const OPAQUE_FUNCTIONS: Record<string, Set<string>> = {
  child_process: new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']),
  vm: new Set([
    'runInNewContext',
    'runInContext',
    'runInThisContext',
    'compileFunction',
    'Script',
    'SourceTextModule',
  ]),
};

/** The `OPAQUE_FUNCTIONS` module a specifier names (`vm`, `node:vm`), if any. */
function opaqueModule(specifier: string): string | undefined {
  const name = specifier.replace(/^node:/, '');

  return Object.hasOwn(OPAQUE_FUNCTIONS, name) ? name : undefined;
}

/**
 * A dynamic `import()`, a Node.js child_process call, or code compiled by `node:vm`: what runs there is invisible
 * to static analysis.
 */
function isOpaqueCall(node: ts.CallExpression | ts.NewExpression, checker: ts.TypeChecker): boolean {
  if (ts.isCallExpression(node) && isRuntimeLoad(node, checker)) return true;
  // By import source, which works without @types/node: `spawnSync(...)`, `cp.spawnSync(...)`, `new vm.Script(...)`.
  const callee = skipParens(node.expression);
  const local = ts.isPropertyAccessExpression(callee) ? skipParens(callee.expression) : callee;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;

  if (ts.isIdentifier(local))
    for (const declaration of checker.getSymbolAtLocation(local)?.declarations ?? []) {
      const imported = ts.isImportSpecifier(declaration)
        ? {
            from: declaration.parent.parent.parent,
            name: (declaration.propertyName ?? declaration.name).text,
          }
        : ts.isNamespaceImport(declaration)
          ? { from: declaration.parent.parent, name }
          : ts.isImportClause(declaration)
            ? { from: declaration.parent, name }
            : undefined;
      const specifier = imported?.from.moduleSpecifier;

      const module = specifier && ts.isStringLiteral(specifier) ? opaqueModule(specifier.text) : undefined;

      if (module && imported?.name !== undefined && OPAQUE_FUNCTIONS[module]?.has(imported.name)) return true;
    }
  let symbol = checker.getSymbolAtLocation(node.expression);

  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);

  if (!symbol) return false;
  const symbolName = symbol.getName();

  // Through the types of @types/node, for the forms the import source does not show.
  return (symbol.declarations ?? []).some((declaration) => {
    const module = /[\\/](child_process|vm)\.d\.ts$/.exec(declaration.getSourceFile().fileName)?.[1];

    return module !== undefined && OPAQUE_FUNCTIONS[module]?.has(symbolName) === true;
  });
}

/** `import()`, `require(...)`, `createRequire(...)`, or a loader made by `createRequire`: modules loaded at run time. */
function isRuntimeLoad(node: ts.CallExpression, checker: ts.TypeChecker): boolean {
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
  // `require(...)` and `createRequire(...)` load modules at run time, which static imports do not show.
  if (ts.isIdentifier(node.expression) && ['require', 'createRequire'].includes(node.expression.text))
    return true;
  // A loader made by `createRequire` (`const load = createRequire(import.meta.url); load('./x')`).
  if (!ts.isIdentifier(node.expression)) return false;
  const declaration = checker.getSymbolAtLocation(node.expression)?.valueDeclaration;
  const initializer =
    declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
      ? skipParens(declaration.initializer)
      : undefined;

  return (
    initializer !== undefined &&
    ts.isCallExpression(initializer) &&
    ts.isIdentifier(initializer.expression) &&
    initializer.expression.text === 'createRequire'
  );
}

function helperInfo(body: ts.Node, ctx: Ctx): CallInfo {
  const cached = ctx.helperInfo.get(body);

  if (cached) return cached;
  // Recursive helpers see themselves as reaching nothing while they are being analysed.
  ctx.helperInfo.set(body, { targets: [], helperAsserts: false, opaque: false });
  const analysis = analyzeBody(body, ctx);
  const bySymbol = new Map<string, Target>();
  // Calls the helper handed mocks to that it also returns (`return props;`).
  const returnedMocks = new Set<Invocation>();

  for (const expression of ts.isBlock(body) ? returnedExpressions(body) : ts.isExpression(body) ? [body] : [])
    for (const item of [expression, ...descendants(expression)])
      if (ts.isIdentifier(item)) {
        const symbol = valueSymbol(item, ctx.checker);

        for (const [call, given] of analysis.mockHolders)
          if (given.some((reference) => reference.symbol === symbol)) returnedMocks.add(call);
      }
  // Mocks the caller can see: declared outside this helper.
  const outside = ({ symbol }: MockReference) =>
    !(symbol.declarations ?? []).some((declaration) => contains(body, declaration));

  for (const entry of analysis.calls) {
    const { node, target } = entry;
    const previous = bySymbol.get(target.symbol);
    const assertedInside =
      target.assertedInside ||
      (target.flowsToResult &&
        analysis.asserted.has(node) &&
        !(target.passThrough && analysis.outputOnly.has(node)) &&
        keysMatch(analysis.assertedKeys.get(node), target)) ||
      analysis.observed.has(entry);
    const flowsToResult = target.flowsToResult && analysis.returned.has(node);
    // Which keys of the result carry this symbol: calls that do not reach the result add none, and only a call that
    // reaches all of it (`null`) widens to the whole result.
    const keys = analysis.returnedKeys.get(node);
    const previousKeys =
      previous && (previous.flowsToResult || previous.returnsMocks)
        ? (previous.resultKeys ?? null)
        : undefined;
    const merged =
      keys === undefined
        ? previousKeys
        : keys === null || previousKeys === null
          ? null
          : new Set([...(previousKeys ?? []), ...keys]);
    const resultKeys = merged ? [...merged] : undefined;
    // What a nested helper does with a mock it is given is decided inside it, where its own targets record it.
    const handed = helperBody(node, ctx) ? [] : (analysis.handed.get(node) ?? []);
    const observedBy = [...(previous?.observedBy ?? []), ...(target.observedBy ?? []), ...handed].filter(
      outside,
    );
    bySymbol.set(target.symbol, {
      symbol: target.symbol,
      ownArgs: false,
      assertedInside: assertedInside || previous?.assertedInside === true,
      flowsToResult: flowsToResult || previous?.flowsToResult === true,
      rendered: target.rendered === true || previous?.rendered === true,
      deferred: (target.deferred === true && flowsToResult) || previous?.deferred === true,
      // Pass-through only if every rendering of it in the helper is.
      passThrough: target.passThrough === true && (previous === undefined || previous.passThrough === true),
      returnsMocks: returnedMocks.has(node) || previous?.returnsMocks === true,
      ...(resultKeys ? { resultKeys } : {}),
      ...(observedBy.length > 0 ? { observedBy } : {}),
    });
  }
  const info: CallInfo = {
    targets: [...bySymbol.values()],
    helperAsserts: analysis.assertions.length > 0 || analysis.helperAsserts,
    opaque: analysis.opaque,
    observesDocument: analysis.observesDocument,
  };
  ctx.helperInfo.set(body, info);

  return info;
}

/** Whether a file is test code inside the root: not project code, a declaration file or a dependency. */
function isTestCodeFile(sourceFile: ts.SourceFile, ctx: Ctx): boolean {
  const file = path.resolve(sourceFile.fileName);
  const relative = path.relative(ctx.root, file);

  return !(
    sourceFile.isDeclarationFile ||
    ctx.projectSet.has(file) ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).includes('node_modules')
  );
}

/**
 * Whether a file imports the test runner's assertions or its mock API as values (`import { expect } from 'vitest'`,
 * `import { vi } from 'vitest'`): that only runs inside a test run, so it is test code wherever it lives. Types and
 * other modules of the runner (a config helper such as `vitest/config`) do not count.
 */
function importsRunnerRuntime(source: ts.SourceFile): boolean {
  return source.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) return false;

    if (!ts.isStringLiteral(statement.moduleSpecifier) || !runner.modules.has(statement.moduleSpecifier.text))
      return false;
    const bindings = statement.importClause?.namedBindings;

    // `import * as vitest from 'vitest'` brings in all of it.
    if (bindings && ts.isNamespaceImport(bindings)) return true;

    return (
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some(
        (element) =>
          !element.isTypeOnly && runner.runtimeExports.has((element.propertyName ?? element.name).text),
      )
    );
  });
}

/** The body of the function a call invokes, when that function is test code inside the root. */
function helperBody(node: Invocation, ctx: Ctx): ts.Node | undefined {
  return helperBodyOf(calleeOf(node), ctx);
}

/** The body of the function an expression names, when that function is test code inside the root. */
function helperBodyOf(expression: ts.Expression, ctx: Ctx): ts.Node | undefined {
  let symbol = ctx.checker.getSymbolAtLocation(expression);

  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = ctx.checker.getAliasedSymbol(symbol);

  for (const declaration of symbol?.declarations ?? []) {
    const fn =
      ts.isVariableDeclaration(declaration) && declaration.initializer
        ? skipParens(declaration.initializer)
        : declaration;

    if (!isFunctionLike(fn) || !fn.body || !isTestCodeFile(fn.getSourceFile(), ctx)) continue;

    return fn.body;
  }

  return undefined;
}

function isFunctionLike(
  node: ts.Node,
): node is ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node)
  );
}

/**
 * Whether a function inside `value` reaches whoever receives `value`: it is `value` itself or sits in array and
 * object literals of it, not in an argument another call already consumes (`Array.from(n, () => ...)`, `xs.map(f)`).
 */
function handedOver(fn: ts.Node, value: ts.Node): boolean {
  for (let current = fn; current !== value; current = current.parent) {
    const parent = current.parent;

    if (!parent) return false;

    if (
      (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
      parent.arguments?.includes(current as ts.Expression) &&
      !isProxyHandler(parent, current)
    )
      return false;

    // Not inside another function's body either: only the outermost functions are handed over.
    if (isFunctionLike(parent) && parent !== fn) return false;
  }

  return true;
}

/**
 * Whether an expression creates a mock of the test runner: `vi.fn(...)` or `vi.spyOn(...)`, possibly configured
 * further (`vi.fn().mockReturnValue(1)`).
 */
function isMockCreation(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  let current = skipParens(expression);

  while (ts.isCallExpression(current)) {
    const role = mockCall(current, checker);

    if (role === 'create' || role === 'spy') return true;

    if (!ts.isPropertyAccessExpression(current.expression)) return false;
    current = skipParens(current.expression.expression);
  }

  return false;
}

/**
 * The local variables an invocation is given that hold mocks of the test runner: mocks themselves, named anywhere in its
 * arguments, and objects holding mocks (`const props = { onSave: vi.fn() }; render(<Dialog {...props} />)`). What a
 * local function called there returns (`render(<Tabs {...defaultProps()} />)`, `useShortcuts(params())`) and what an
 * object it is given holds (`editorRef = { current: mockEditor }`) are followed.
 */
function mockHoldersPassed(call: Invocation, checker: ts.TypeChecker): MockHolders {
  const cached = mockHoldersCache.get(call);

  if (cached) return cached;
  const result = findMockHolders(call, checker);
  mockHoldersCache.set(call, result);

  return result;
}

/** What `mockHoldersPassed` finds; a member path names the property of a container that was passed. */
interface MockHolders {
  mocks: ts.VariableDeclaration[];
  containers: { declaration: ts.VariableDeclaration; path: string[]; except?: string[] }[];
}

const mockHoldersCache = new WeakMap<Invocation, MockHolders>();
const invocationsGivenCache = new WeakMap<ts.SourceFile, Map<ts.VariableDeclaration, Invocation[]>>();

/**
 * The invocations of a file's shared setup (module or describe level, `beforeEach`/`beforeAll`) that are given a mock
 * variable (see `mockHoldersPassed`), worked out once per file.
 */
function invocationsGiven(declaration: ts.VariableDeclaration, checker: ts.TypeChecker): Invocation[] {
  const source = declaration.getSourceFile();
  let given = invocationsGivenCache.get(source);

  if (!given) {
    given = new Map();

    // Only shared setup can run before a test body (see `runsBefore`); calls inside tests are left out here.
    for (const node of descendants(source))
      if (isInvocation(node) && runsBefore(node, undefined))
        for (const mock of mockHoldersPassed(node, checker).mocks) {
          const list = given.get(mock);

          if (list) list.push(node);
          else given.set(mock, [node]);
        }
    invocationsGivenCache.set(source, given);
  }

  return given.get(declaration) ?? [];
}

function findMockHolders(call: Invocation, checker: ts.TypeChecker): MockHolders {
  const mocks = new Set<ts.VariableDeclaration>();
  const containers = new Map<
    string,
    { declaration: ts.VariableDeclaration; path: string[]; except?: string[] }
  >();
  const followed = new Set<string>();
  const ids = new Map<ts.Node, number>();
  // Each value with the top-level properties of it that do not reach the callee (`<Dialog {...props} onSave={x} />`
  // replaces `props.onSave`).
  const values: { expression: ts.Expression; except: Set<string> }[] = handedValues(call, checker);
  const follow = (node: ts.Node, key: string, expressions: ts.Expression[], except = new Set<string>()) => {
    if (!ids.has(node)) ids.set(node, ids.size);
    const id = `${ids.get(node)}:${key}:${[...except].join(',')}`;

    if (followed.has(id) || followed.size >= 20) return;
    followed.add(id);
    values.push(...expressions.map((expression) => ({ expression, except })));
  };

  for (let index = 0; index < values.length; index++) {
    const { expression: argument, except } = values[index] as (typeof values)[number];
    const literal = skipParens(argument);

    // An object literal hands over its properties but the replaced ones.
    if (ts.isObjectLiteralExpression(literal) && except.size > 0) {
      for (const property of literal.properties) {
        const name = property.name && ts.isIdentifier(property.name) ? property.name.text : undefined;

        if (name !== undefined && except.has(name)) continue;

        if (ts.isPropertyAssignment(property))
          values.push({ expression: property.initializer, except: new Set() });
        else if (ts.isShorthandPropertyAssignment(property))
          values.push({ expression: property.name, except: new Set() });
        else if (ts.isSpreadAssignment(property)) values.push({ expression: property.expression, except });
      }
      continue;
    }

    if (ts.isCallExpression(literal) && except.size > 0) {
      const fn = localFunction(skipParens(literal.expression), checker);

      if (fn && isFunctionLike(fn) && fn.body)
        follow(
          fn,
          '',
          ts.isBlock(fn.body) ? returnedExpressions(fn.body) : [fn.body as ts.Expression],
          except,
        );
      continue;
    }

    for (const item of [argument, ...descendants(argument)]) {
      if (ts.isCallExpression(item)) {
        const fn = localFunction(skipParens(item.expression), checker);

        if (fn && isFunctionLike(fn) && fn.body)
          follow(fn, '', ts.isBlock(fn.body) ? returnedExpressions(fn.body) : [fn.body as ts.Expression]);
      }

      if (!ts.isIdentifier(item)) continue;
      // In `{ cloneObject }` the name is the property; the variable is its value.
      const symbol = valueSymbol(item, checker);
      const declaration = symbol?.valueDeclaration;
      // `const { onSave } = props`: the member `onSave` of the object `props` holds.
      const member = declaration && destructuredMember(declaration, checker);
      // Reading a mock's state (`String(onSave.mock.calls.length)`) hands over a number, not the mock.
      const readsMockState = memberPath(item).includes('mock');

      if (readsMockState) continue;

      if (member && memberPath(item).length === 0) {
        containers.set(`${member.declaration.pos}:${member.name}`, {
          declaration: member.declaration,
          path: [member.name],
        });
        follow(
          member.declaration,
          member.name,
          memberValues(valuesOf(member.declaration, checker), [member.name]),
        );
      }
      const holding =
        declaration && ts.isVariableDeclaration(declaration) ? mockHolding(declaration, checker) : undefined;

      // Only the mock function itself is handed over, not one of its members (`onSave.name`).
      if (holding === 'mock' && memberPath(item).length === 0)
        mocks.add(declaration as ts.VariableDeclaration);

      if (holding === 'container' && declaration && ts.isVariableDeclaration(declaration)) {
        // `title={props.title}` hands over only `title`; `{...props}` or `props` hands over all of it, but the
        // properties a later attribute replaces.
        const path = memberPath(item);
        const replaced = item === literal && path.length === 0 ? [...except] : [];
        containers.set(`${ids.get(declaration) ?? declaration.pos}:${path.join('.')}:${replaced.join(',')}`, {
          declaration,
          path,
          ...(replaced.length > 0 ? { except: replaced } : {}),
        });
        follow(
          declaration,
          path.join('.'),
          memberValues(valuesOf(declaration, checker), path),
          new Set(replaced),
        );
      }

      // `renderHook((props) => useAutoSave(props), { initialProps: params })` calls the hook with `params`.
      const initialProps = declaration && renderHookInitialProps(declaration, checker);

      if (declaration && initialProps) follow(declaration, '', [initialProps]);

      // `const run = vi.spyOn(source, 'run'); wrap(source)`: the spy watches a method of what is passed.
      for (const spy of symbol ? (spiesOn(item.getSourceFile(), checker).get(symbol) ?? []) : [])
        mocks.add(spy);
    }
  }

  return { mocks: [...mocks], containers: [...containers.values()] };
}

/**
 * The values an invocation hands over (see `argumentsOf`). For a JSX element, props resolve in order: an attribute
 * written after a spread replaces that property of the spread, and a spread after an attribute may replace it, so
 * that attribute is not counted unless the spread's own properties are known not to include it.
 */
function handedValues(
  call: Invocation,
  checker: ts.TypeChecker,
): { expression: ts.Expression; except: Set<string> }[] {
  if (!isJsxInvocation(call))
    return argumentsOf(call).map((expression) => ({ expression, except: new Set() }));
  const attributes = call.attributes.properties;
  const values: { expression: ts.Expression; except: Set<string> }[] = [];
  const nameOf = (attribute: ts.JsxAttributeLike) =>
    ts.isJsxAttribute(attribute) && ts.isIdentifier(attribute.name) ? attribute.name.text : undefined;

  for (const [index, attribute] of attributes.entries()) {
    const later = attributes.slice(index + 1);

    if (ts.isJsxSpreadAttribute(attribute)) {
      const replaced = new Set(later.map(nameOf).filter((name): name is string => name !== undefined));
      let unknown = false;

      // A later spread replaces the members it supplies; one whose keys are not known may replace any.
      for (const other of later)
        if (ts.isJsxSpreadAttribute(other)) {
          const keys = spreadKeys(other.expression, checker);

          if (keys) for (const key of keys) replaced.add(key);
          else unknown = true;
        }

      if (!unknown) values.push({ expression: attribute.expression, except: replaced });
      continue;
    }
    const name = nameOf(attribute);
    const replacedBySpread = later.some(
      (other) =>
        ts.isJsxSpreadAttribute(other) &&
        (name === undefined || spreadKeys(other.expression, checker)?.has(name) !== false),
    );
    const value = attribute.initializer;

    if (!replacedBySpread && value && ts.isJsxExpression(value) && value.expression)
      values.push({ expression: value.expression, except: new Set() });
  }

  if (ts.isJsxOpeningElement(call))
    for (const child of call.parent.children)
      if (ts.isJsxExpression(child) && child.expression)
        values.push({ expression: child.expression, except: new Set() });

  return values;
}

/** The property names a spread value is known to have: an object literal, or a local initialised with one. */
function spreadKeys(expression: ts.Expression, checker: ts.TypeChecker): Set<string> | undefined {
  let value = skipParens(expression);

  if (ts.isIdentifier(value)) {
    const declaration = valueSymbol(value, checker)?.valueDeclaration;

    if (declaration && ts.isParameter(declaration)) return parameterKeys(declaration, checker);
    const initializer = variableInitializer(declaration);

    if (!initializer) return undefined;
    value = skipParens(initializer);
  }

  return objectKeys(value);
}

/**
 * The keys a helper's parameter can hold (`const renderDialog = (overrides = {}) => …`): those of its default and of
 * the object literals every call of the helper in the file passes. Unknown when any call passes something else.
 */
function parameterKeys(parameter: ts.ParameterDeclaration, checker: ts.TypeChecker): Set<string> | undefined {
  const fn = parameter.parent;
  const index = fn.parameters.indexOf(parameter);
  let current: ts.Node = fn;

  while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
  const holder = current.parent;
  const name =
    ts.isFunctionDeclaration(fn) && fn.name
      ? fn.name
      : ts.isVariableDeclaration(holder) && holder.initializer === current && ts.isIdentifier(holder.name)
        ? holder.name
        : undefined;
  const symbol = name && checker.getSymbolAtLocation(name);

  if (!symbol) return undefined;
  const keys = new Set<string>();

  for (const reference of referencesOf(symbol, fn.getSourceFile(), checker)) {
    if (reference === name) continue;
    const call = reference.parent;

    if (!ts.isCallExpression(call) || call.expression !== reference) return undefined;
    const argument = call.arguments[index] ?? parameter.initializer;
    const found = argument ? objectKeys(skipParens(argument)) : new Set<string>();

    if (!found) return undefined;

    for (const key of found) keys.add(key);
  }

  return keys;
}

/** The property names of an object literal without spreads or computed names. */
function objectKeys(value: ts.Expression): Set<string> | undefined {
  if (!ts.isObjectLiteralExpression(value)) return undefined;
  const keys = new Set<string>();

  for (const property of value.properties) {
    if (ts.isSpreadAssignment(property)) return undefined;

    if (ts.isShorthandPropertyAssignment(property)) {
      keys.add(property.name.text);
      continue;
    }

    if (property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)))
      keys.add(property.name.text);
    else return undefined;
  }

  return keys;
}

/**
 * The object variable and member a destructured binding takes (`const { onSave } = props`, `{ onSave: save }`), when
 * that variable holds mocks.
 */
function destructuredMember(
  declaration: ts.Declaration,
  checker: ts.TypeChecker,
): { declaration: ts.VariableDeclaration; name: string } | undefined {
  if (
    !ts.isBindingElement(declaration) ||
    declaration.dotDotDotToken ||
    !ts.isObjectBindingPattern(declaration.parent)
  )
    return undefined;
  const holder = declaration.parent.parent;
  const property = declaration.propertyName ?? declaration.name;

  if (!ts.isVariableDeclaration(holder) || !holder.initializer || !ts.isIdentifier(property))
    return undefined;
  const source = skipParens(holder.initializer);
  const object = ts.isIdentifier(source) ? checker.getSymbolAtLocation(source)?.valueDeclaration : undefined;

  return object && ts.isVariableDeclaration(object) && mockHolding(object, checker) !== undefined
    ? { declaration: object, name: property.text }
    : undefined;
}

/** The plain member path read below an identifier: `props.a.b` gives `['a', 'b']`; a computed member ends it. */
function memberPath(identifier: ts.Identifier): string[] {
  const path: string[] = [];
  let current: ts.Node = identifier;

  while (
    (ts.isPropertyAccessExpression(current.parent) || ts.isElementAccessExpression(current.parent)) &&
    current.parent.expression === current
  ) {
    const name = memberName(current.parent);

    if (name === undefined) break;
    path.push(name);
    current = current.parent;
  }

  return path;
}

/**
 * The values below a member path of what a variable is given: in `{ current: editor }`, `current` is `editor`. A value
 * whose shape is not an object literal is kept whole.
 */
function memberValues(values: ts.Expression[], path: string[]): ts.Expression[] {
  if (path.length === 0) return values;
  const [name, ...rest] = path;

  return values.flatMap((value) => {
    const object = skipParens(value);

    if (!ts.isObjectLiteralExpression(object)) return [value];
    const found = object.properties.flatMap((property) =>
      ts.isSpreadAssignment(property)
        ? [property.expression]
        : property.name && ts.isIdentifier(property.name) && property.name.text === name
          ? ts.isPropertyAssignment(property)
            ? [property.initializer]
            : ts.isShorthandPropertyAssignment(property)
              ? [property.name]
              : []
          : [],
    );

    return memberValues(found, rest);
  });
}

/**
 * The `initialProps` a parameter of a Testing Library `renderHook` callback receives: in
 * `renderHook((props) => useHook(props), { initialProps: params })`, `props` is `params`.
 */
function renderHookInitialProps(
  declaration: ts.Declaration,
  checker: ts.TypeChecker,
): ts.Expression | undefined {
  const callback = declaration.parent;

  if (!ts.isParameter(declaration) || !isFunction(callback) || callback.parameters[0] !== declaration)
    return undefined;
  const call = callback.parent;

  if (!ts.isCallExpression(call) || call.arguments[0] !== callback) return undefined;

  if (testingLibraryMember(call.expression, checker) !== 'renderHook') return undefined;
  const options = call.arguments[1] && skipParens(call.arguments[1]);

  if (!options || !ts.isObjectLiteralExpression(options)) return undefined;

  for (const property of options.properties) {
    if (property.name && ts.isIdentifier(property.name) && property.name.text === 'initialProps') {
      if (ts.isPropertyAssignment(property)) return property.initializer;

      if (ts.isShorthandPropertyAssignment(property)) return property.name;
    }
  }

  return undefined;
}

/** The values a variable is given: its initializer, or what it is assigned (a `let` set in a hook). */
function valuesOf(declaration: ts.VariableDeclaration, checker: ts.TypeChecker): ts.Expression[] {
  if (declaration.initializer) return [declaration.initializer];

  if (!ts.isIdentifier(declaration.name)) return [];
  const symbol = checker.getSymbolAtLocation(declaration.name);

  return symbol ? assignmentsTo(symbol, declaration.getSourceFile(), checker) : [];
}

/** Whether a variable holds a mock of the test runner (see `mockHolding`). */
function holdsMock(declaration: ts.VariableDeclaration, checker: ts.TypeChecker): boolean {
  return mockHolding(declaration, checker) === 'mock';
}

const mockHoldingCache = new WeakMap<ts.VariableDeclaration, 'mock' | 'container' | null>();
const deciding = new Set<ts.VariableDeclaration>();
let cycleSeen = false;

/**
 * What a variable holds: a mock of the test runner (`const onSave = vi.fn()`, or a `let` only ever assigned mocks in a hook), an
 * object or array holding mocks (`{ onSave: vi.fn() }`, what a local `createProps()` returns), or neither.
 */
function mockHolding(
  declaration: ts.VariableDeclaration,
  checker: ts.TypeChecker,
): 'mock' | 'container' | undefined {
  const cached = mockHoldingCache.get(declaration);

  if (cached !== undefined) return cached ?? undefined;

  // Cycles (`a = { b }; b = { a }`) see a variable being decided as holding nothing. What is decided meanwhile
  // depends on that guess, so it is not kept; the variable the cycle started from is decided in full.
  if (deciding.has(declaration)) {
    cycleSeen = true;

    return undefined;
  }
  deciding.add(declaration);
  const outerCycle = cycleSeen;
  cycleSeen = false;
  const kinds = valuesOf(declaration, checker).map((value) => mockValue(value, checker, 0));
  const result =
    kinds.length > 0 && kinds.every((kind) => kind === 'mock')
      ? 'mock'
      : kinds.some((kind) => kind !== undefined)
        ? 'container'
        : undefined;
  deciding.delete(declaration);

  if (!cycleSeen || deciding.size === 0) mockHoldingCache.set(declaration, result ?? null);
  cycleSeen = outerCycle || (cycleSeen && deciding.size > 0);

  return result;
}

/** Whether an expression makes a mock of the test runner, or an object or array holding one (see `mockHolding`). */
function mockValue(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  depth: number,
): 'mock' | 'container' | undefined {
  const value = skipParens(expression);

  if (depth > 5) return undefined;

  if (isMockCreation(value, checker)) return 'mock';
  const inner = (item: ts.Expression) => mockValue(item, checker, depth + 1);
  const holds = (items: ts.Expression[]) =>
    items.some((item) => inner(item) !== undefined) ? 'container' : undefined;

  if (ts.isObjectLiteralExpression(value))
    return holds(
      value.properties.flatMap((property) =>
        ts.isPropertyAssignment(property)
          ? [property.initializer]
          : ts.isShorthandPropertyAssignment(property)
            ? [property.name]
            : ts.isSpreadAssignment(property)
              ? [property.expression]
              : [],
      ),
    );

  if (ts.isArrayLiteralExpression(value))
    return holds(
      value.elements.map((element) => (ts.isSpreadElement(element) ? element.expression : element)),
    );

  if (ts.isIdentifier(value)) {
    const declaration = valueSymbol(value, checker)?.valueDeclaration;

    return declaration && ts.isVariableDeclaration(declaration)
      ? mockHolding(declaration, checker)
      : undefined;
  }

  if (!ts.isCallExpression(value)) return undefined;
  // A cast helper that hands back what it is given (`asMock(vi.fn())`).
  const passed = passthroughArgument(value, checker);

  if (passed) return inner(passed);
  // What a local factory returns (`const createProps = () => ({ onSave: vi.fn() })`).
  const fn = localFunction(skipParens(value.expression), checker);

  if (!fn || !isFunctionLike(fn) || !fn.body) return undefined;
  const kinds = (ts.isBlock(fn.body) ? returnedExpressions(fn.body) : [fn.body as ts.Expression]).map(inner);

  return kinds.length > 0 && kinds.every((kind) => kind === 'mock')
    ? 'mock'
    : kinds.some((kind) => kind !== undefined)
      ? 'container'
      : undefined;
}

/**
 * The argument a call hands back unchanged: the callee only returns one of its parameters, possibly cast
 * (`function asMock<T>(fn: Mock): T { return fn as unknown as T; }`).
 */
function passthroughArgument(call: ts.CallExpression, checker: ts.TypeChecker): ts.Expression | undefined {
  let symbol = checker.getSymbolAtLocation(skipParens(call.expression));

  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol?.declarations?.[0];
  const fn =
    declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
      ? skipParens(declaration.initializer)
      : declaration;

  if (!fn || !isFunctionLike(fn) || !fn.body || fn.getSourceFile().isDeclarationFile) return undefined;
  const returned = ts.isBlock(fn.body) ? returnedExpressions(fn.body) : [fn.body as ts.Expression];
  const indexes = new Set(
    returned.map((item) => {
      const value = skipParens(item);

      return ts.isIdentifier(value)
        ? fn.parameters.findIndex(
            (parameter) =>
              ts.isIdentifier(parameter.name) &&
              checker.getSymbolAtLocation(parameter.name) === checker.getSymbolAtLocation(value),
          )
        : -1;
    }),
  );

  if (indexes.size !== 1) return undefined;
  const [index] = [...indexes];

  return index !== undefined && index >= 0 ? call.arguments[index] : undefined;
}

const spiesCache = new WeakMap<ts.SourceFile, Map<ts.Symbol, ts.VariableDeclaration[]>>();

/** The variables of a file holding `vi.spyOn(object, …)`, by the variable `object` names. */
function spiesOn(source: ts.SourceFile, checker: ts.TypeChecker): Map<ts.Symbol, ts.VariableDeclaration[]> {
  const cached = spiesCache.get(source);
  if (cached) return cached;
  const spies = new Map<ts.Symbol, ts.VariableDeclaration[]>();

  for (const node of descendants(source)) {
    if (!ts.isVariableDeclaration(node) || !node.initializer) continue;
    let spy = skipParens(node.initializer);

    // Configured further: `vi.spyOn(o, 'm').mockReturnValue(1)`.
    while (
      ts.isCallExpression(spy) &&
      mockCall(spy, checker) !== 'spy' &&
      ts.isPropertyAccessExpression(spy.expression)
    )
      spy = skipParens(spy.expression.expression);
    const watched =
      ts.isCallExpression(spy) && mockCall(spy, checker) === 'spy' ? spy.arguments[0] : undefined;
    const symbol = watched && ts.isIdentifier(watched) ? checker.getSymbolAtLocation(watched) : undefined;

    if (symbol && symbol.valueDeclaration?.getSourceFile() === source)
      spies.set(symbol, [...(spies.get(symbol) ?? []), node]);
  }
  spiesCache.set(source, spies);

  return spies;
}

/**
 * Whether code outside a test body runs before it as shared setup: at module or describe level, or in a
 * `beforeEach`/`beforeAll` hook, of describes that enclose the body. Code in another test, in an unrelated
 * describe or in a function that is only defined there does not.
 */
function runsBefore(node: ts.Node, body: ts.Node | undefined): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (!isFunctionLike(current)) continue;
    const call = current.parent;

    if (!call || !ts.isCallExpression(call)) return false;
    const suite = describeRegistration(call);

    if (suite?.callback === current) {
      // Without a body: whether the code is shared setup of some describe at all.
      if (body && !contains(current, body)) return false;
      continue;
    }
    const hook = ts.isIdentifier(call.expression) ? call.expression.text : undefined;

    if (hook === undefined || !runner.setup.has(hook)) return false;
  }

  return true;
}

/**
 * Whether `node` is the handler of `new Proxy(target, handler)`: its traps run whenever whoever receives the proxy
 * uses it, so they are handed over with the proxy.
 */
function isProxyHandler(invocation: ts.CallExpression | ts.NewExpression, node: ts.Node): boolean {
  return (
    ts.isNewExpression(invocation) &&
    ts.isIdentifier(invocation.expression) &&
    invocation.expression.text === 'Proxy' &&
    invocation.arguments?.[1] === node
  );
}

/** Variables declared outside a callback that it assigns (`x = …`, `x.y = …`) or mutates (`x.push(…)`). */
function writtenOuterIdentifiers(callback: ts.Node, checker: ts.TypeChecker): ts.Identifier[] {
  const rootOf = (expression: ts.Expression): ts.Identifier | undefined => {
    let current = skipParens(expression);

    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current))
      current = skipParens(current.expression);

    return ts.isIdentifier(current) ? current : undefined;
  };
  const written: ts.Identifier[] = [];

  for (const node of descendants(callback)) {
    let target: ts.Identifier | undefined;

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      target = rootOf(node.left);
    else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression))
      target = rootOf(node.expression.expression);
    else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    )
      target = rootOf(node.operand);
    const declaration = target && checker.getSymbolAtLocation(target)?.valueDeclaration;

    if (
      target &&
      declaration?.getSourceFile() === callback.getSourceFile() &&
      !contains(callback, declaration)
    )
      written.push(target);
  }

  return written;
}

/** Expressions a function body returns or yields, not those of functions nested in it. */
function returnedExpressions(body: ts.Block): ts.Expression[] {
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (isFunctionLike(node)) return;

    if (ts.isReturnStatement(node) && node.expression) found.push(node.expression);

    // A generator hands out what it yields (`yield f(x)`, or every value of `yield* values`).
    if (ts.isYieldExpression(node) && node.expression) found.push(node.expression);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);

  return found;
}

/** Right-hand sides of `name = value` anywhere in the file, for a `let` set in a hook. */
function assignmentsTo(symbol: ts.Symbol, source: ts.SourceFile, checker: ts.TypeChecker): ts.Expression[] {
  let assignments = assignmentsCache.get(source);

  if (!assignments) {
    // Every `name = value` of the file at once: looking them up per variable would walk the file each time.
    const found = new Map<ts.Symbol, ts.Expression[]>();

    for (const node of descendants(source)) {
      if (
        !ts.isBinaryExpression(node) ||
        node.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
        !ts.isIdentifier(node.left)
      )
        continue;
      const target = checker.getSymbolAtLocation(node.left);

      if (target) {
        const list = found.get(target);

        if (list) list.push(node.right);
        else found.set(target, [node.right]);
      }
    }
    assignments = found;
    assignmentsCache.set(source, assignments);
  }

  return assignments.get(symbol) ?? [];
}

const assignmentsCache = new WeakMap<ts.SourceFile, Map<ts.Symbol, ts.Expression[]>>();

function visitTests(
  source: ts.SourceFile,
  suitePath: string[],
  inheritedModifiers: TestCaseType['modifiers'],
  file: string,
  mocks: MockRecord[],
  ctx: Ctx,
  output: TestCaseType[],
): void {
  const walk = (node: ts.Node, currentSuite: string[], currentModifiers: TestCaseType['modifiers']) => {
    if (ts.isCallExpression(node)) {
      const describe = describeRegistration(node);

      if (describe) {
        const name = literalString(node.arguments[0]);
        const callback = callbackArgument(node);

        if (name !== undefined && callback && isFunction(callback)) {
          const childModifiers = [...new Set([...currentModifiers, ...describe.modifiers])];
          ts.forEachChild(callback, (child) => walk(child, [...currentSuite, name], childModifiers));

          return;
        }
      }
      const info = testRegistration(node);

      if (info) {
        output.push(
          analyzeTest(
            node,
            { ...info, modifiers: [...new Set([...currentModifiers, ...info.modifiers])] },
            currentSuite,
            file,
            mocks,
            ctx,
          ),
        );

        return;
      }
    }
    ts.forEachChild(node, (child) => walk(child, currentSuite, currentModifiers));
  };
  walk(source, suitePath, inheritedModifiers);
}

type Registration = { name?: string; callback?: ts.Expression; modifiers: TestCaseType['modifiers'] };

/** Vitest takes `(name, fn, timeout | options)` as well as `(name, options, fn)`: the callback is the last function. */
function callbackArgument(node: ts.CallExpression): ts.Expression | undefined {
  return node.arguments.slice(1).findLast(isFunction) ?? node.arguments.at(-1);
}

/**
 * Whether a call makes a registration function instead of registering (`test.skipIf(cond)` in
 * `test.skipIf(cond)('name', fn)`): the call that uses its result registers.
 */
function makesRegistration(node: ts.CallExpression): boolean {
  return ts.isCallExpression(node.parent) && node.parent.expression === node;
}

/**
 * The member a registration call gets its registration function from: `it.each` in `it.each(table)(name, fn)`, and in
 * the tagged template form `it.each\`table\`(name, fn)`; undefined for a direct call.
 */
function registrationFactory(node: ts.CallExpression): ts.Expression | undefined {
  if (ts.isCallExpression(node.expression)) return node.expression.expression;

  return ts.isTaggedTemplateExpression(node.expression) ? node.expression.tag : undefined;
}

/**
 * Registration factories (`.each(table)`, `.for(table)`, `.skipIf(cond)`, `.runIf(cond)` in Vitest) return the
 * function that registers.
 */
function testRegistration(node: ts.CallExpression): Registration | undefined {
  const direct = makesRegistration(node) ? undefined : registration(node, runner.tests);

  if (direct && Array.isArray(direct))
    return { name: literalString(node.arguments[0]), callback: callbackArgument(node), modifiers: direct };

  const factory = registrationFactory(node);

  if (factory) {
    const chain = propertyChain(factory);
    const root = rootIdentifier(factory);

    if (root && runner.tests.has(root) && chain.some((name) => runner.registrationFactories.has(name))) {
      const eachModifiers = chain.filter((name): name is TestCaseType['modifiers'][number] =>
        runner.modifiers.has(name),
      );

      if (chain.some((name) => runner.tableFactories.has(name)) && !eachModifiers.includes('each'))
        eachModifiers.push('each');
      const implied = runner.shorthands.get(root);

      if (implied !== undefined && !eachModifiers.includes(implied)) eachModifiers.unshift(implied);

      if (chain.some((name) => runner.expectedFailure.has(name))) eachModifiers.push('expected_failure');

      return {
        name: literalString(node.arguments[0]),
        callback: callbackArgument(node),
        modifiers: eachModifiers,
      };
    }
  }

  return undefined;
}

function describeRegistration(node: ts.CallExpression): Registration | undefined {
  const direct = makesRegistration(node) ? undefined : registration(node, runner.suites);

  if (direct && Array.isArray(direct)) {
    return { name: literalString(node.arguments[0]), callback: callbackArgument(node), modifiers: direct };
  }

  const factory = registrationFactory(node);

  if (!factory) return undefined;
  const chain = propertyChain(factory);
  const root = rootIdentifier(factory);

  if (!root || !runner.suites.has(root) || !chain.some((name) => runner.registrationFactories.has(name)))
    return undefined;
  const eachModifiers = chain.filter((name): name is TestCaseType['modifiers'][number] =>
    runner.modifiers.has(name),
  );

  if (chain.some((name) => runner.tableFactories.has(name)) && !eachModifiers.includes('each'))
    eachModifiers.push('each');
  const implied = runner.shorthands.get(root);

  if (implied !== undefined && !eachModifiers.includes(implied)) eachModifiers.unshift(implied);

  return {
    name: literalString(node.arguments[0]),
    callback: callbackArgument(node),
    modifiers: eachModifiers,
  };
}

const runnerAliases = new WeakMap<ts.SourceFile, Map<string, string>>();

/**
 * The export of the test runner's modules a local name stands for: itself, or the name imported as it
 * (`import { it as vIt } from 'vitest'`).
 */
function runnerName(identifier: ts.Identifier): string {
  const source = identifier.getSourceFile();
  let aliases = runnerAliases.get(source);

  if (!aliases) {
    aliases = new Map();

    for (const statement of source.statements) {
      const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined;

      if (
        !bindings ||
        !ts.isNamedImports(bindings) ||
        !ts.isStringLiteral((statement as ts.ImportDeclaration).moduleSpecifier) ||
        !runner.modules.has(((statement as ts.ImportDeclaration).moduleSpecifier as ts.StringLiteral).text)
      )
        continue;

      for (const element of bindings.elements)
        if (element.propertyName) aliases.set(element.name.text, element.propertyName.text);
    }
    runnerAliases.set(source, aliases);
  }

  return aliases.get(identifier.text) ?? identifier.text;
}

/** The modifiers of a call to one of `names` (`it.skip(...)`), or undefined when it calls none of them. */
function registration(node: ts.CallExpression, names: Set<string>): TestCaseType['modifiers'] | undefined {
  const chain: string[] = [];
  let expression: ts.Expression = node.expression;

  while (ts.isPropertyAccessExpression(expression)) {
    chain.push(expression.name.text);
    expression = expression.expression;
  }

  if (!ts.isIdentifier(expression)) return undefined;
  const name = runnerName(expression);

  if (!names.has(name)) return undefined;
  const found = chain.filter((member): member is TestCaseType['modifiers'][number] =>
    runner.modifiers.has(member),
  );
  // `xit(...)` is `it.skip(...)`.
  const implied = runner.shorthands.get(name);

  if (chain.some((member) => runner.expectedFailure.has(member))) found.push('expected_failure');

  return implied !== undefined && !found.includes(implied) ? [implied, ...found] : found;
}

function analyzeTest(
  registrationCall: ts.CallExpression,
  info: Registration,
  suitePath: string[],
  file: string,
  mocks: MockRecord[],
  ctx: Ctx,
): TestCaseType {
  const { checker, root } = ctx;
  const source = registrationCall.getSourceFile();
  const callback = info.callback;
  const name = info.name ?? '<dynamic test>';
  const body = callback && isFunction(callback) ? callback.body : undefined;
  const nodes = body ? descendants(body) : [];
  const contextParameter =
    callback && isFunction(callback) && callback.parameters[0] && ts.isIdentifier(callback.parameters[0].name)
      ? checker.getSymbolAtLocation(callback.parameters[0].name)
      : undefined;
  const analysis = body
    ? analyzeBody(
        body,
        ctx,
        (node) => isContextAssertion(node, contextParameter, checker),
        setupRenders(source, ctx)
          .filter(
            ({ node, call }) => !contains(body, node) && !contains(body, call) && runsBefore(call, body),
          )
          .map(({ node }) => node),
        setupWriteNodes(source, checker)
          .filter(({ node, scope }) => !contains(body, node) && runsBefore(scope, body))
          .map(({ node }) => documentWriteOf(node, source, checker))
          .filter((write): write is DocumentWrite => write !== undefined)
          .map((write) => ({ ...write, end: Number.NEGATIVE_INFINITY })),
        false,
      )
    : undefined;
  const assertions = analysis?.assertions ?? [];
  const unresolvedImports = analysis?.unresolvedImports ?? new Set<string>();
  const calledSymbols = [...new Set(analysis?.calls.map((call) => call.target.symbol))];
  const relativeFile = toPosixRelative(root, file);
  const allCalls = (analysis?.calls ?? []).map((entry) => {
    const { node, target } = entry;

    return {
      symbol: target.symbol,
      // A helper's or a method's arguments are not the project function's, so they say nothing about its inputs.
      // Neither are a JSX element's props, which the component takes as one object.
      args:
        target.ownArgs && !ts.isTaggedTemplateExpression(node) && !isJsxInvocation(node)
          ? argumentsOf(node).map(literalArgument)
          : [],
      asserted:
        target.assertedInside ||
        (target.flowsToResult &&
          analysis?.asserted.has(node) === true &&
          !(target.passThrough && analysis.outputOnly.has(node)) &&
          keysMatch(analysis.assertedKeys.get(node), target)) ||
        analysis?.observed.has(entry) === true,
      location: location(source, node, relativeFile),
      reachedVia: [...(analysis?.reached.get(entry) ?? [])].sort(),
    };
  });
  // A component a local function of the body renders is recorded twice, once where the function is written and once
  // where it is called (`const make = () => <Dialog />; render(make())`): keep the call, with either one's check.
  const entries = analysis?.calls ?? [];
  const duplicateOf = entries.map((entry) => {
    if (!body || !isJsxInvocation(entry.node)) return -1;
    const fn = enclosingFunction(entry.node, body);

    return fn && isFunctionLike(fn) && fn.body
      ? entries.findIndex(
          (other) =>
            other !== entry &&
            other.target.symbol === entry.target.symbol &&
            isInvocation(other.node) &&
            helperBody(other.node, ctx) === fn.body,
        )
      : -1;
  });
  const targetCalls = allCalls
    .map((call, index) => ({
      ...call,
      asserted:
        call.asserted ||
        duplicateOf.some(
          (original, duplicate) => original === index && allCalls[duplicate]?.asserted === true,
        ),
    }))
    .filter((_, index) => (duplicateOf[index] ?? -1) < 0)
    // A route is evidence only where no assertion is linked to the call.
    .map(({ reachedVia, ...call }): TestCaseType['targetCalls'][number] =>
      call.asserted || reachedVia.length === 0 ? call : { ...call, reachedVia },
    );
  // Tautological only when every compared value (subject and expected) is a compile-time
  // constant; runtime values such as process.env or non-project call results are not.
  // Only type-level checks: Vitest's `expectTypeOf`/`assertType`, or no runtime assertion but a type check written
  // as a type alias (`type _ = Expect<Equal<A, B>>`) or a call with type arguments (`assertEqual<A, B>(true)`).
  const typeLevel =
    (assertions.length > 0 && assertions.every(isTypeLevelAssertion)) ||
    (assertions.length === 0 && body !== undefined && hasTypeOnlyCheck(body));
  // Type-level checks compare types, not values, so they are neither constant nor about a value.
  const comparisons = assertions.filter(
    (assertion) => !isAssertionCountCall(assertion) && !isTypeLevelAssertion(assertion),
  );
  const tautological =
    comparisons.length > 0 &&
    comparisons.every((assertion) =>
      comparedValues(assertion).every((value) => isCompileTimeConstant(value, checker)),
    );
  const applicableMocks = mocks.filter((mock) => mockApplies(mock, registrationCall, callback));
  const usesMocks = applicableMocks.length > 0;
  const mockedTarget = applicableMocks.some((mock) =>
    mock.targets.some((target) => calledSymbols.includes(target)),
  );
  const usesSnapshots = nodes.some(
    (node) =>
      ts.isCallExpression(node) &&
      /\.(toMatchSnapshot|toMatchInlineSnapshot|toMatchFileSnapshot)\s*\(/.test(node.getText()),
  );
  const fakeTimers = nodes.some(
    (node) => ts.isCallExpression(node) && node.getText().includes('useFakeTimers'),
  );
  const nondeterminism = [...new Set(nodes.flatMap((node) => nondeterminismFor(node, fakeTimers)))];
  const suspicions: TestCaseType['suspicions'] = [];

  if (
    assertions.length === 0 &&
    !typeLevel &&
    !analysis?.helperAsserts &&
    !callsHelperWithAssertion(body, source)
  )
    suspicions.push('no_assertion');

  if (tautological) suspicions.push('tautological_assertion');
  // Code that runs when the file loads (outside any function), its own or that of the local modules it imports,
  // runs before every test in it.
  const loading = fileLoadReach(source, ctx);
  const opaque = analysis?.opaque === true || loading.opaque;
  const unresolved = unresolvedImports.size > 0 || loading.unresolved;

  // An unresolved import, a child process or a dynamic import may well reach project code: absence is not proven.
  // Inside a function that registers tests with values its caller supplies (a shared or parameterized suite), what a
  // test calls is decided at the call site, which may be another file.
  const callerSupplied =
    calledSymbols.length === 0 && body !== undefined && usesSuiteParameters(registrationCall, body, checker);

  if (typeLevel) suspicions.push('type_level_only');
  else if (callerSupplied) suspicions.push('caller_supplied');
  else if (calledSymbols.length === 0 && !unresolved && !opaque) suspicions.push('target_not_called');

  if (mockedTarget) suspicions.push('unconditional_mock');

  if (unresolved) suspicions.push('unresolved_import');

  if (opaque) suspicions.push('opaque_call');

  if (analysis?.progressOnly) suspicions.push('progress_only');

  if (!targetCalls.some((call) => call.asserted) && targetCalls.some((call) => call.reachedVia !== undefined))
    suspicions.push('reachable_by_name');

  return {
    id: testId(toPosixRelative(root, file), suitePath, name),
    file: toPosixRelative(root, file),
    name,
    suitePath,
    location: location(source, registrationCall, relativeFile),
    modifiers: [...new Set(info.modifiers)],
    assertionCount: assertions.length,
    calledSymbols,
    targetCalls,
    usesMocks,
    usesSnapshots,
    nondeterminism,
    suspicions,
    granularity: info.name === undefined ? 'suite' : 'test',
  };
}

function resolveProjectCall(
  node: Invocation,
  checker: ts.TypeChecker,
  projectSet: Set<string>,
  root: string,
): string | undefined {
  return projectSymbolId(aliasTarget(calleeOf(node), checker), checker, projectSet, root);
}

/** The symbol an expression names, through `const local = projectFunction` aliases of the test file. */
function aliasTarget(expression: ts.Expression, checker: ts.TypeChecker): ts.Symbol | undefined {
  let symbol = checker.getSymbolAtLocation(skipParens(expression));

  for (let depth = 0; symbol && depth < 5; depth++) {
    const declaration = symbol.valueDeclaration;

    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      !(declaration.parent.flags & ts.NodeFlags.Const) ||
      !declaration.initializer
    )
      break;
    const initializer = skipParens(declaration.initializer);

    if (!ts.isIdentifier(initializer) && !ts.isPropertyAccessExpression(initializer)) break;
    symbol = checker.getSymbolAtLocation(initializer);
  }

  return symbol;
}

/**
 * Project functions an invocation is given as values (`[1, 2].map(double)`, `run(object, compare)`): the code it
 * calls runs them, so their results are part of its result.
 */
function passedProjectFunctions(node: Invocation, ctx: Ctx, projectReceives: boolean): string[] {
  const found: string[] = [];

  // `expect(fn)` compares the function as a value; it does not run it.
  if (ts.isCallExpression(node) && isAssertionChainCall(node)) return found;

  // A function given directly, or, to project code whose body shows it calls what it gets, as a value in an
  // object or array literal (`run({ cb: double })`). A built-in such as `Object.assign` may only store those.
  const given = (argument: ts.Expression): ts.Expression[] => {
    const value = skipParens(argument);

    if (!projectReceives) return [value];

    if (ts.isObjectLiteralExpression(value))
      return value.properties.flatMap((p) =>
        ts.isPropertyAssignment(p)
          ? given(p.initializer)
          : ts.isShorthandPropertyAssignment(p)
            ? [p.name]
            : [],
      );

    if (ts.isArrayLiteralExpression(value)) return value.elements.flatMap(given);

    return [value];
  };

  // `<button onClick={handleClick}>` registers the handler; it runs only when an event fires.
  const registered = new Set<ts.Node>();

  if (isJsxInvocation(node) && !projectReceives && helperBody(node, ctx) === undefined)
    for (const attribute of node.attributes.properties)
      if (
        ts.isJsxAttribute(attribute) &&
        ts.isIdentifier(attribute.name) &&
        /^on[A-Z]/.test(attribute.name.text) &&
        attribute.initializer &&
        ts.isJsxExpression(attribute.initializer) &&
        attribute.initializer.expression &&
        !firesEvents(eventScope(node))
      )
        registered.add(skipParens(attribute.initializer.expression));

  for (const [index, argument] of argumentsOf(node).entries())
    for (const value of given(argument)) {
      if (registered.has(value)) continue;

      if (!ts.isIdentifier(value) && !ts.isPropertyAccessExpression(value)) continue;

      if (ctx.checker.getTypeAtLocation(value).getCallSignatures().length === 0) continue;

      if (projectReceives && !mayCallArgument(node, index, ctx.checker)) continue;
      const id = projectSymbolId(aliasTarget(value, ctx.checker), ctx.checker, ctx.projectSet, ctx.root);

      if (id) found.push(id);
    }

  return found;
}

/**
 * Whether the function an invocation runs may change its `index`-th argument: its body writes a property of that
 * parameter, calls a method on it, passes it on or aliases it. Unknown when the body is not visible (a method, a
 * declaration file), which counts as "may".
 */
function mayChangeArgument(node: Invocation, index: number, checker: ts.TypeChecker): boolean {
  // Rendering reads props; a component that changes what it is given is not assumed.
  if (isJsxInvocation(node)) return false;
  const symbol = aliasTarget(calleeOf(node), checker);
  const resolved = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const fn = (resolved?.declarations ?? [])
    .map((d) => (ts.isVariableDeclaration(d) && d.initializer ? skipParens(d.initializer) : d))
    .find(
      (d): d is ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration =>
        isFunctionLike(d) && d.body !== undefined,
    );

  if (!fn?.body || ts.isTaggedTemplateExpression(node)) return true;
  const parameter = fn.parameters[index];

  if (!parameter) return fn.parameters.some((p) => p.dotDotDotToken !== undefined);

  if (parameter.dotDotDotToken || !ts.isIdentifier(parameter.name)) return true;
  const target = checker.getSymbolAtLocation(parameter.name);

  return descendants(fn.body).some((item) => {
    if (!ts.isIdentifier(item) || checker.getSymbolAtLocation(item) !== target) return false;
    let use: ts.Node = item;

    while (
      ts.isParenthesizedExpression(use.parent) ||
      ts.isNonNullExpression(use.parent) ||
      ts.isAsExpression(use.parent)
    )
      use = use.parent;
    const parent = use.parent;

    // Read-only uses: a property read, a comparison, `typeof`, a condition. Anything else may change it.
    if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) {
      let access: ts.Node = parent;

      while (ts.isPropertyAccessExpression(access.parent) || ts.isElementAccessExpression(access.parent))
        access = access.parent;
      const outer = access.parent;

      return (
        (ts.isCallExpression(outer) && outer.expression === access) ||
        ts.isDeleteExpression(outer) ||
        ((ts.isPrefixUnaryExpression(outer) || ts.isPostfixUnaryExpression(outer)) &&
          (outer.operator === ts.SyntaxKind.PlusPlusToken ||
            outer.operator === ts.SyntaxKind.MinusMinusToken)) ||
        (ts.isBinaryExpression(outer) &&
          outer.left === access &&
          outer.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          outer.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
      );
    }

    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind >= ts.SyntaxKind.FirstBinaryOperator &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastBinaryOperator &&
      !(
        parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      )
    )
      return false;

    if (ts.isTypeOfExpression(parent) || ts.isIfStatement(parent) || ts.isPrefixUnaryExpression(parent))
      return false;

    if (ts.isConditionalExpression(parent) && parent.condition === use) return false;

    return true;
  });
}

/** Methods that keep a value in a collection without calling it. */
const STORING_METHODS = new Set(['push', 'unshift', 'set', 'add', 'splice', 'concat']);

/**
 * Whether the function an invocation runs may call its `index`-th argument: its body calls that parameter, or
 * passes it to a call other than one that only stores it. Unknown bodies count as "may".
 */
function mayCallArgument(node: Invocation, index: number, checker: ts.TypeChecker): boolean {
  // Props are not positional parameters: whether the component calls one is not known here.
  if (isJsxInvocation(node)) return true;
  const symbol = aliasTarget(calleeOf(node), checker);
  const resolved = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const fn = (resolved?.declarations ?? [])
    .map((d) => (ts.isVariableDeclaration(d) && d.initializer ? skipParens(d.initializer) : d))
    .find(
      (d): d is ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration =>
        isFunctionLike(d) && d.body !== undefined,
    );

  if (!fn?.body) return true;
  const parameter = fn.parameters[index];

  if (!parameter || parameter.dotDotDotToken || !ts.isIdentifier(parameter.name)) return true;
  const target = checker.getSymbolAtLocation(parameter.name);

  return descendants(fn.body).some((item) => {
    if (!ts.isIdentifier(item) || checker.getSymbolAtLocation(item) !== target) return false;
    let use: ts.Node = item;

    while (
      ts.isParenthesizedExpression(use.parent) ||
      ts.isNonNullExpression(use.parent) ||
      ts.isAsExpression(use.parent)
    )
      use = use.parent;
    const parent = use.parent;

    // `cb(...)`, `cb?.(...)`, and a call through a member: `cb.call(...)`, `cb.apply(...)`, `options.cb()`.
    if (ts.isCallExpression(parent) && parent.expression === use) return true;

    if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) {
      let access: ts.Node = parent;

      while (ts.isPropertyAccessExpression(access.parent) || ts.isElementAccessExpression(access.parent))
        access = access.parent;

      return ts.isCallExpression(access.parent) && access.parent.expression === access;
    }

    if (
      (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
      parent.arguments?.includes(use as ts.Expression)
    ) {
      const callee = skipParens(parent.expression);

      return !(ts.isPropertyAccessExpression(callee) && STORING_METHODS.has(callee.name.text));
    }

    return false;
  });
}

/** A local that holds an object (or a value of unknown type), which a function it is passed to can change. */
function passedByReference(identifier: ts.Identifier, checker: ts.TypeChecker): boolean {
  const type = checker.getTypeAtLocation(identifier);
  const primitive =
    ts.TypeFlags.StringLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.ESSymbolLike |
    ts.TypeFlags.Null |
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Void;

  if (type.flags & primitive) return false;

  if (type.getCallSignatures().length === 0) return true;
  // A function written in the test is followed by what it writes. Any other callable value, such as `vi.fn()`,
  // records how project code called it, which is an output of that call.
  const declaration = checker.getSymbolAtLocation(identifier)?.valueDeclaration;

  return Boolean(
    declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      !isFunctionLike(skipParens(declaration.initializer)),
  );
}

/**
 * Local files a source file reaches through static imports, re-exports and literal `import()`, transitively. Declaration files and dependencies under node_modules are not followed: a workspace package
 * imported through its built `.d.ts` runs its build output, which changing the source does not affect.
 */
function localDependencies(start: ts.SourceFile, checker: ts.TypeChecker, root: string): string[] {
  return loadedFiles(start, checker, root)
    .map((source) => toPosixRelative(root, source.fileName))
    .sort();
}

/** The local files a source names in its imports, re-exports and literal dynamic imports, in source order. */
const directImportsCache = new WeakMap<ts.SourceFile, ts.SourceFile[]>();

function directLocalImports(source: ts.SourceFile, checker: ts.TypeChecker, root: string): ts.SourceFile[] {
  const cached = directImportsCache.get(source);

  if (cached) return cached;
  const found: ts.SourceFile[] = [];

  for (const node of descendants(source)) {
    let specifier: ts.Expression | undefined;

    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
      specifier = node.moduleSpecifier;
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      specifier = node.arguments[0];

    if (!specifier || !ts.isStringLiteralLike(specifier)) continue;
    const target = checker
      .getSymbolAtLocation(specifier)
      ?.declarations?.find((declaration) => ts.isSourceFile(declaration));

    if (!target || !ts.isSourceFile(target) || target.isDeclarationFile) continue;
    const relative = path.relative(root, path.resolve(target.fileName));

    if (
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      relative.split(path.sep).includes('node_modules')
    )
      continue;
    found.push(target);
  }
  directImportsCache.set(source, found);

  return found;
}

/**
 * The local files a file loads, transitively: what its imports, re-exports and dynamic imports name. Each file's
 * own imports are read once per analysis, and so is the closure of each start file.
 */
const loadedFilesCache = new WeakMap<ts.SourceFile, ts.SourceFile[]>();

function loadedFiles(start: ts.SourceFile, checker: ts.TypeChecker, root: string): ts.SourceFile[] {
  const cached = loadedFilesCache.get(start);

  if (cached) return cached;
  const seen = new Set<ts.SourceFile>([start]);
  const queue = [start];

  for (let source = queue.shift(); source; source = queue.shift())
    for (const target of directLocalImports(source, checker, root)) {
      if (seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  const result = [...seen].filter((source) => source !== start);
  loadedFilesCache.set(start, result);

  return result;
}

/**
 * The local files whose code a test file may run, followed symbol by symbol: an import of `{ f }` through a barrel
 * counts the file that declares `f`, not every module the barrel re-exports. A file counted is counted whole, and
 * its own imports are followed the same way. When in doubt a file is counted whole: a test left out would let a
 * mutant it kills survive. Counted whole are the targets of side-effect imports, of namespace imports used other
 * than as `ns.member`, of re-exports in a counted file, of `vi.mock`-style and dynamic imports, and every loaded file
 * whose top level runs more than declarations. Type-only imports count nothing.
 */
function usedDependencies(
  start: ts.SourceFile,
  checker: ts.TypeChecker,
  root: string,
  cache: Map<ts.SourceFile, ts.SourceFile[]>,
  resolveModule: ModuleResolver,
): string[] {
  const local = (file: ts.SourceFile | undefined): file is ts.SourceFile => {
    if (!file || file.isDeclarationFile) return false;
    const relative = path.relative(root, path.resolve(file.fileName));

    return !(
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      relative.split(path.sep).includes('node_modules')
    );
  };
  const queue: ts.SourceFile[] = [start];
  const used = new Set<ts.SourceFile>([start]);

  // ES modules run the top level of every module they load, used or not.
  for (const source of loadedFiles(start, checker, root))
    if (hasLoadTimeEffects(source)) {
      used.add(source);
      queue.push(source);
    }

  for (let source = queue.shift(); source; source = queue.shift()) {
    let direct = cache.get(source);

    if (!direct) {
      direct = directlyUsedFiles(source, checker, resolveModule).filter(local);
      cache.set(source, direct);
    }

    for (const file of direct)
      if (!used.has(file)) {
        used.add(file);
        queue.push(file);
      }
  }

  return [...used]
    .filter((source) => source !== start)
    .map((source) => toPosixRelative(root, source.fileName))
    .sort();
}

type ModuleResolver = (name: string, containingFile: string) => ts.SourceFile | undefined;

/** The files whose code a file may run through its imports, re-exports, mocks and dynamic imports. */
function directlyUsedFiles(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  resolveModule: ModuleResolver,
): ts.SourceFile[] {
  const found = new Set<ts.SourceFile>();
  const moduleOf = (specifier: ts.Expression | undefined): ts.SourceFile | undefined => {
    if (!specifier || !ts.isStringLiteralLike(specifier)) return undefined;
    const declaration = checker.getSymbolAtLocation(specifier)?.declarations?.find(ts.isSourceFile);

    return declaration && ts.isSourceFile(declaration) ? declaration : undefined;
  };
  const whole = (file: ts.SourceFile | undefined) => {
    if (file) found.add(file);
  };
  // The files that declare what a name refers to, through every re-export; the module when that fails.
  const declared = (name: ts.Identifier, module: ts.SourceFile | undefined) => {
    let symbol = checker.getSymbolAtLocation(name);

    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const files = (symbol?.declarations ?? []).map((declaration) =>
      ts.isSourceFile(declaration) ? declaration : declaration.getSourceFile(),
    );

    if (files.length === 0) whole(module);

    for (const file of files) whole(file);
  };

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const module = moduleOf(statement.moduleSpecifier);
      const clause = statement.importClause;

      // `import './setup'` runs the module for its effects.
      if (!clause) {
        whole(module);
        continue;
      }

      if (clause.isTypeOnly) continue;

      if (clause.name) declared(clause.name, module);
      const bindings = clause.namedBindings;

      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements) if (!element.isTypeOnly) declared(element.name, module);

      if (bindings && ts.isNamespaceImport(bindings)) {
        const members = namespaceMembers(bindings.name, source, checker);

        if (members === null) whole(module);
        else for (const member of members) declared(member, module);
      }
      continue;
    }

    // What a file re-exports may be used by whoever imports it as a whole.
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && !statement.isTypeOnly)
      whole(moduleOf(statement.moduleSpecifier));
  }

  for (const node of descendants(source)) {
    if (!ts.isCallExpression(node)) continue;

    // `import('./x')`, and the modules `vi.mock('./x')` and friends replace or load.
    if (node.expression.kind === ts.SyntaxKind.ImportKeyword) whole(moduleOf(node.arguments[0]));
    else if (isModuleMockCall(node, checker)) {
      const name = node.arguments[0];

      if (name && ts.isStringLiteralLike(name)) whole(resolveModule(name.text, source.fileName));
    }
  }

  return [...found].filter((file) => file !== source);
}

/** Mock calls that name a module to replace or load (`vi.mock('./x')`, `vi.importActual('./x')`). */
const MODULE_MOCK_ROLES = new Set<MockCallRole>(['module_hoisted', 'module', 'module_access', 'module_late']);

function isModuleMockCall(node: ts.CallExpression, checker: ts.TypeChecker): boolean {
  const role = mockCall(node, checker);

  return role !== undefined && MODULE_MOCK_ROLES.has(role);
}

/**
 * The `member` names of a namespace import when every use of it is `ns.member`; null when it is also used
 * otherwise (passed on, spread, iterated), which may reach any export.
 */
function namespaceMembers(
  name: ts.Identifier,
  source: ts.SourceFile,
  checker: ts.TypeChecker,
): ts.Identifier[] | null {
  const symbol = checker.getSymbolAtLocation(name);
  const members: ts.Identifier[] = [];

  for (const node of descendants(source)) {
    if (!ts.isIdentifier(node) || node === name || checker.getSymbolAtLocation(node) !== symbol) continue;
    const parent = node.parent;

    if (ts.isPropertyAccessExpression(parent) && parent.expression === node && ts.isIdentifier(parent.name))
      members.push(parent.name);
    // `ns.Type` in a type annotation runs nothing.
    else if (ts.isQualifiedName(parent) && parent.left === node) continue;
    else return null;
  }

  return members;
}

/**
 * Whether loading a module runs more than declarations: anything at its top level other than imports, exports,
 * types, function declarations, classes without decorators or static initializers, enums, and `const`/`let`
 * bindings of literals and functions.
 */
function hasLoadTimeEffects(source: ts.SourceFile): boolean {
  const inert = (expression: ts.Expression | undefined): boolean => {
    if (!expression) return true;
    const value = skipParens(expression);

    return (
      ts.isLiteralExpression(value) ||
      ts.isNoSubstitutionTemplateLiteral(value) ||
      value.kind === ts.SyntaxKind.TrueKeyword ||
      value.kind === ts.SyntaxKind.FalseKeyword ||
      value.kind === ts.SyntaxKind.NullKeyword ||
      ts.isIdentifier(value) ||
      ts.isArrowFunction(value) ||
      ts.isFunctionExpression(value) ||
      (ts.isPrefixUnaryExpression(value) && inert(value.operand)) ||
      ((ts.isAsExpression(value) || ts.isSatisfiesExpression(value)) && inert(value.expression)) ||
      (ts.isArrayLiteralExpression(value) &&
        value.elements.every((element) => !ts.isSpreadElement(element) && inert(element))) ||
      (ts.isObjectLiteralExpression(value) &&
        value.properties.every(
          (property) =>
            (ts.isPropertyAssignment(property) &&
              !ts.isComputedPropertyName(property.name) &&
              inert(property.initializer)) ||
            ts.isShorthandPropertyAssignment(property) ||
            ts.isMethodDeclaration(property),
        ))
    );
  };

  return !source.statements.every((statement) => {
    if (
      ts.isImportDeclaration(statement) ||
      ts.isExportDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement) ||
      ts.isEmptyStatement(statement)
    )
      return true;

    if (ts.isClassDeclaration(statement))
      return (
        !ts.getDecorators(statement)?.length &&
        statement.members.every(
          (member) =>
            !ts.isClassStaticBlockDeclaration(member) &&
            !(ts.canHaveDecorators(member) && ts.getDecorators(member)?.length) &&
            !(
              ts.isPropertyDeclaration(member) &&
              member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) &&
              !inert(member.initializer)
            ),
        ) &&
        (statement.heritageClauses ?? []).every((clause) =>
          clause.types.every((type) => ts.isIdentifier(type.expression)),
        )
      );

    if (ts.isVariableStatement(statement))
      return statement.declarationList.declarations.every(
        (declaration) => ts.isIdentifier(declaration.name) && inert(declaration.initializer),
      );

    if (ts.isExportAssignment(statement)) return inert(statement.expression);

    return false;
  });
}

const TEST_SUPPORT_DIRECTORIES = new Set(['test', 'tests', '__tests__', '__mocks__', 'e2e']);

/**
 * Whether a file (POSIX, relative to the root) lives in a test directory. Helpers next to the tests are test
 * code even when a broad include matches them: they are followed, not targets.
 */
export function isTestSupportPath(relative: string): boolean {
  return relative
    .split('/')
    .slice(0, -1)
    .some((segment) => TEST_SUPPORT_DIRECTORIES.has(segment));
}

function isTestSupportFile(root: string, file: string): boolean {
  return isTestSupportPath(toPosixRelative(root, file));
}

function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];

  return name.elements.flatMap((element) =>
    ts.isBindingElement(element) ? bindingIdentifiers(element.name) : [],
  );
}

const moduleLoadCache = new WeakMap<ts.SourceFile, { opaque: boolean; unresolved: boolean }>();
const fileLoadCache = new WeakMap<ts.SourceFile, { opaque: boolean; unresolved: boolean }>();

/** `moduleLoadReach` of a test file and of every local file it imports, transitively. */
function fileLoadReach(source: ts.SourceFile, ctx: Ctx): { opaque: boolean; unresolved: boolean } {
  const cached = fileLoadCache.get(source);
  if (cached) return cached;
  const files = [
    source,
    ...localDependencies(source, ctx.checker, ctx.root).map((file) =>
      ctx.program.getSourceFile(path.resolve(ctx.root, file)),
    ),
  ].filter((file): file is ts.SourceFile => file !== undefined);
  const reach = files.map((file) => moduleLoadReach(file, ctx.checker));
  const result = { opaque: reach.some((r) => r.opaque), unresolved: reach.some((r) => r.unresolved) };
  fileLoadCache.set(source, result);
  return result;
}

/**
 * What a file runs when it loads: opaque calls outside any function, and relative imports or re-exports that do
 * not resolve (their module, if it exists at run time, is loaded and executed before the tests).
 */
function moduleLoadReach(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
): { opaque: boolean; unresolved: boolean } {
  const cached = moduleLoadCache.get(source);
  if (cached) return cached;
  let opaque = false;
  let unresolved = false;
  const visit = (node: ts.Node) => {
    // A function body runs later, unless the function is invoked right away (an IIFE).
    if (isFunctionLike(node)) {
      let outer: ts.Node = node.parent;
      while (ts.isParenthesizedExpression(outer)) outer = outer.parent;
      const invoked = ts.isCallExpression(outer) && skipParens(outer.expression) === node;
      if (!invoked) return;
    }
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && isOpaqueCall(node, checker)) opaque = true;
    const specifier =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier : undefined;
    if (
      specifier &&
      ts.isStringLiteral(specifier) &&
      specifier.text.startsWith('.') &&
      !checker.getSymbolAtLocation(specifier)
    )
      unresolved = true;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  const result = { opaque, unresolved };
  moduleLoadCache.set(source, result);
  return result;
}

/**
 * Whether a file runs code out of process, loads modules at run time (dynamic import, `require`, `createRequire`),
 * or imports a relative module that does not resolve.
 */
function hasUnseenReach(source: ts.SourceFile, checker: ts.TypeChecker): boolean {
  return descendants(source).some((node) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) return isOpaqueCall(node, checker);
    const specifier =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier : undefined;

    return (
      specifier !== undefined &&
      ts.isStringLiteral(specifier) &&
      specifier.text.startsWith('.') &&
      !checker.getSymbolAtLocation(specifier)
    );
  });
}

/** The relative module specifier a callee is imported from, when TypeScript cannot resolve that module. */
function unresolvedImportOf(callee: ts.Expression, ctx: Ctx): string | undefined {
  let current = skipParens(callee);

  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current))
    current = skipParens(current.expression);

  if (!ts.isIdentifier(current)) return undefined;

  for (const declaration of ctx.checker.getSymbolAtLocation(current)?.declarations ?? []) {
    const importDeclaration = ts.isImportSpecifier(declaration)
      ? declaration.parent.parent.parent
      : ts.isNamespaceImport(declaration)
        ? declaration.parent.parent
        : ts.isImportClause(declaration)
          ? declaration.parent
          : undefined;
    const specifier = importDeclaration?.moduleSpecifier;

    if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) continue;

    // Ask the checker, not resolveModuleName: it applies the importing file's ESM/CJS resolution mode.
    if (!ctx.checker.getSymbolAtLocation(specifier)) return specifier.text;
  }

  return undefined;
}

function projectSymbolId(
  input: ts.Symbol | undefined,
  checker: ts.TypeChecker,
  projectSet: Set<string>,
  root: string,
): string | undefined {
  let symbol = input;

  if (!symbol) return undefined;

  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol.declarations?.find((item) =>
    projectSet.has(path.resolve(item.getSourceFile().fileName)),
  );

  if (!declaration) return undefined;

  return symbolId(toPosixRelative(root, declaration.getSourceFile().fileName), symbol.getName());
}

/** A call to a real mock API of the test runner, with the project symbols it replaces (if any). */
interface MockRecord {
  node: ts.CallExpression;
  /** A hoisted module mock (`vi.mock`) applies to every test in the file wherever it is written. */
  fileWide: boolean;
  targets: string[];
}

/**
 * Mock calls recorded as mocks of a test; loading a module (`module_access`) is not one, nor a replacement that only
 * later loads see (`module_late`): the code a test reaches through static imports stays the real one.
 */
const RECORDED_MOCK_ROLES = new Set<MockCallRole>([
  'module_hoisted',
  'module',
  'spy',
  'create',
  'wrap',
  'stub_global',
]);

/**
 * What `vi.<name>(...)` does (see `MockCallRole`), where `vi` is a mock object of the test runner, imported from its
 * module or the ambient global.
 */
function mockCall(node: ts.Expression, checker: ts.TypeChecker): MockCallRole | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression;

  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return undefined;

  if (!runner.mockObjects.has(callee.expression.text)) return undefined;
  const declarations = checker.getSymbolAtLocation(callee.expression)?.declarations ?? [];
  const fromRunner = declarations.every((declaration) => {
    if (!ts.isImportSpecifier(declaration)) return declaration.getSourceFile().isDeclarationFile;
    const specifier = declaration.parent.parent.parent.moduleSpecifier;

    return ts.isStringLiteral(specifier) && runner.modules.has(specifier.text);
  });

  return fromRunner ? runner.mockCalls.get(callee.name.text) : undefined;
}

function collectMocks(source: ts.SourceFile, ctx: Ctx): MockRecord[] {
  const { checker, projectSet, root } = ctx;
  const records: MockRecord[] = [];
  const spyTargets = (spy: ts.Expression): string[] => {
    const target = skipParens(spy);

    if (!ts.isCallExpression(target)) return [];
    const role = mockCall(target, checker);

    if (role === 'wrap') {
      const argument = target.arguments[0];
      const id =
        argument && projectSymbolId(checker.getSymbolAtLocation(argument), checker, projectSet, root);

      return id ? [id] : [];
    }

    if (role !== 'spy') return [];
    const [object, nameNode] = target.arguments;
    const name = literalString(nameNode);

    if (!object || name === undefined) return [];
    let owner = checker.getSymbolAtLocation(object);

    if (owner && owner.flags & ts.SymbolFlags.Alias) owner = checker.getAliasedSymbol(owner);
    const member =
      owner && owner.flags & ts.SymbolFlags.ValueModule
        ? checker.getExportsOfModule(owner).find((item) => item.getName() === name)
        : checker.getTypeAtLocation(object).getProperty(name);
    const id = projectSymbolId(member, checker, projectSet, root);

    return id ? [id] : [];
  };
  const spyVariable = (identifier: ts.Identifier): string[] | undefined => {
    const declaration = checker.getSymbolAtLocation(identifier)?.valueDeclaration;

    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return undefined;
    const role = mockCall(skipParens(declaration.initializer), checker);

    return role === 'spy' || role === 'wrap' || role === 'create'
      ? spyTargets(declaration.initializer)
      : undefined;
  };

  for (const node of descendants(source)) {
    if (!ts.isCallExpression(node)) continue;
    const role = mockCall(node, checker);

    if (role && RECORDED_MOCK_ROLES.has(role)) {
      const targets =
        role === 'module_hoisted' || role === 'module' ? moduleExports(node.arguments[0], ctx) : [];
      records.push({ node, fileWide: role === 'module_hoisted', targets });
      continue;
    }
    // `<spy>.mockReturnValue(...)` and friends, only on real spies of the test runner.
    const callee = node.expression;

    if (!ts.isPropertyAccessExpression(callee) || !runner.configureMethod.test(callee.name.text)) continue;
    const receiver = skipParens(callee.expression);
    const receiverRole = mockCall(receiver, checker);

    if (receiverRole === 'spy' || receiverRole === 'wrap' || receiverRole === 'create')
      records.push({ node, fileWide: false, targets: spyTargets(receiver) });
    else if (ts.isIdentifier(receiver)) {
      const targets = spyVariable(receiver);

      if (targets) records.push({ node, fileWide: false, targets });
    }
  }

  return records;
}

/** Resolved module files by containing directory and specifier, for the run of one inventory. */
const resolvedModules = new Map<string, string | undefined>();

/** The file a module specifier resolves to from `containingFile`, or undefined when it does not resolve. */
function resolvedModuleFile(specifier: string, containingFile: string, ctx: Ctx): string | undefined {
  const key = `${path.dirname(containingFile)}\0${specifier}`;

  if (resolvedModules.has(key)) return resolvedModules.get(key);
  const resolved = ts.resolveModuleName(
    specifier,
    containingFile,
    ctx.compilerOptions,
    ts.sys,
  ).resolvedModule;
  const file = resolved ? path.resolve(resolved.resolvedFileName) : undefined;
  resolvedModules.set(key, file);

  return file;
}

/**
 * The file of the module `identifier` is imported from (a named, default or namespace import of the test file),
 * when the test file replaces that module with a hoisted module mock (`vi.mock('./api')`); otherwise undefined.
 */
function mockedModuleOf(identifier: ts.Identifier, ctx: Ctx): string | undefined {
  const declaration = ctx.checker.getSymbolAtLocation(identifier)?.declarations?.[0];
  let node: ts.Node | undefined = declaration;

  while (node && !ts.isImportDeclaration(node)) node = node.parent;

  if (!node || !ts.isImportDeclaration(node) || node.importClause?.isTypeOnly) return undefined;
  const specifier = literalString(node.moduleSpecifier);
  const source = node.getSourceFile();
  const file = specifier === undefined ? undefined : resolvedModuleFile(specifier, source.fileName, ctx);

  if (file === undefined) return undefined;
  let mocked = mockedModulesCache.get(source);

  if (!mocked) {
    mocked = new Set();

    for (const call of descendants(source)) {
      if (!ts.isCallExpression(call) || mockCall(call, ctx.checker) !== 'module_hoisted') continue;
      const argument = call.arguments[0] && skipParens(call.arguments[0]);
      const target =
        argument && ts.isCallExpression(argument) && argument.expression.kind === ts.SyntaxKind.ImportKeyword
          ? argument.arguments[0]
          : argument;
      const name = literalString(target);
      const resolved = name === undefined ? undefined : resolvedModuleFile(name, source.fileName, ctx);

      if (resolved !== undefined) mocked.add(resolved);
    }
    mockedModulesCache.set(source, mocked);
  }

  return mocked.has(file) ? file : undefined;
}

/** Per test file, the module files its hoisted module mocks replace. */
const mockedModulesCache = new WeakMap<ts.SourceFile, Set<string>>();

/** Globals a test can put a mock into: `window.x = mock`, `globalThis.x = mock`. */
const GLOBAL_HOLDERS = new Set(['window', 'globalThis', 'global', 'self']);
/** Configuration of a mock's result: the value it returns or resolves to, or an implementation returning it. */
const MOCK_RESULT = /^mock(?:Resolved|Rejected)?(?:Return)?Value(?:Once)?$|^mockImplementation(?:Once)?$/;

/** Whether an identifier names a global of the environment (declared only in declaration files, not imported). */
function isGlobalIdentifier(identifier: ts.Identifier, checker: ts.TypeChecker): boolean {
  const declarations = checker.getSymbolAtLocation(identifier)?.declarations ?? [];

  return declarations.length > 0 && declarations.every((item) => item.getSourceFile().isDeclarationFile);
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = skipParens(expression);

  while (
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  )
    current = skipParens(current.expression);

  return current;
}

/** The global member a write targets (`window.monaco = …` gives `monaco`), or undefined. */
function globalMemberWritten(left: ts.Expression, checker: ts.TypeChecker): string | undefined {
  const target = unwrapExpression(left);

  if (!ts.isPropertyAccessExpression(target)) return undefined;
  const holder = unwrapExpression(target.expression);

  return ts.isIdentifier(holder) && GLOBAL_HOLDERS.has(holder.text) && isGlobalIdentifier(holder, checker)
    ? target.name.text
    : undefined;
}

/** A value a test file hands to a mocked module or a global, and where project code would meet it. */
type MockHolder = { value: ts.Node; module?: string; global?: string };

/**
 * Per function, the globals it assigns one of its parameters to, or a value built from it, by parameter index
 * (`(m) => { window.monaco = { ...m } }`).
 */
const globalSettersCache = new WeakMap<ts.Node, Map<number, string>>();

function globalSetter(
  fn: ts.SignatureDeclaration & { body?: ts.Node },
  checker: ts.TypeChecker,
): Map<number, string> {
  const cached = globalSettersCache.get(fn);

  if (cached) return cached;
  const found = new Map<number, string>();
  const parameters = fn.parameters.map((parameter) =>
    ts.isIdentifier(parameter.name) ? checker.getSymbolAtLocation(parameter.name) : undefined,
  );

  for (const node of fn.body ? descendants(fn.body) : []) {
    if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
    const name = globalMemberWritten(node.left, checker);

    if (name === undefined) continue;

    // The parameter itself or a value built from it (`window.monaco = { KeyMod, ...extra }`).
    for (const item of [node.right, ...descendants(node.right)]) {
      const index = ts.isIdentifier(item) ? parameters.indexOf(checker.getSymbolAtLocation(item)) : -1;

      if (index >= 0) found.set(index, name);
    }
  }
  globalSettersCache.set(fn, found);

  return found;
}

/**
 * Where a test file hands values to code it does not call itself: module mock factories (`vi.mock('./api', () =>
 * …)`), the result configured for a mock of a mocked module (`vi.mocked(load).mockResolvedValue(store)`), and
 * globals (`window.monaco = mock`, `vi.stubGlobal('monaco', mock)`, a helper that assigns its argument to a global).
 */
const fileMockHoldersCache = new WeakMap<ts.SourceFile, MockHolder[]>();

function fileMockHolders(source: ts.SourceFile, ctx: Ctx): MockHolder[] {
  const cached = fileMockHoldersCache.get(source);

  if (cached) return cached;
  const { checker } = ctx;
  const holders: MockHolder[] = [];
  const specifierFile = (argument: ts.Expression | undefined): string | undefined => {
    const node = argument && skipParens(argument);
    const target =
      node && ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        ? node.arguments[0]
        : node;
    const name = literalString(target);

    return name === undefined ? undefined : resolvedModuleFile(name, source.fileName, ctx);
  };

  for (const node of descendants(source)) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const name = globalMemberWritten(node.left, checker);

      if (name !== undefined) holders.push({ value: node.right, global: name });
      continue;
    }

    if (!ts.isCallExpression(node)) continue;
    const role = mockCall(node, checker);

    if (role === 'module_hoisted') {
      const file = specifierFile(node.arguments[0]);

      if (file !== undefined && node.arguments[1]) holders.push({ value: node.arguments[1], module: file });
      continue;
    }

    if (role === 'stub_global') {
      const name = literalString(node.arguments[0]);

      if (name !== undefined && node.arguments[1]) holders.push({ value: node.arguments[1], global: name });
      continue;
    }
    const callee = skipParens(node.expression);

    // `<mock>.mockResolvedValue(value)` on an export of a mocked module, directly or through `vi.mocked(...)`.
    if (ts.isPropertyAccessExpression(callee) && MOCK_RESULT.test(callee.name.text) && node.arguments[0]) {
      let receiver = unwrapExpression(callee.expression);

      if (ts.isCallExpression(receiver) && mockCall(receiver, checker) !== undefined && receiver.arguments[0])
        receiver = unwrapExpression(receiver.arguments[0]);

      while (ts.isPropertyAccessExpression(receiver)) receiver = unwrapExpression(receiver.expression);
      const file = ts.isIdentifier(receiver) ? mockedModuleOf(receiver, ctx) : undefined;

      if (file !== undefined) holders.push({ value: node.arguments[0], module: file });
      continue;
    }

    // A helper that assigns an argument to a global (`setWindowMonaco(mock)`), wherever it is declared.
    let symbol = ts.isIdentifier(callee) ? checker.getSymbolAtLocation(callee) : undefined;

    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const declaration = symbol?.valueDeclaration;
    const fn =
      declaration && ts.isFunctionDeclaration(declaration)
        ? declaration
        : declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
          ? skipParens(declaration.initializer)
          : undefined;

    if (
      fn &&
      (ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
      !fn.getSourceFile().isDeclarationFile
    )
      for (const [index, name] of globalSetter(fn, checker)) {
        const argument = node.arguments[index];

        if (argument) holders.push({ value: argument, global: name });
      }
  }
  fileMockHoldersCache.set(source, holders);

  return holders;
}

/** The member path below an identifier where it is used (`h.removeTabs.mock` gives `['removeTabs', 'mock']`). */
function usedPath(identifier: ts.Identifier): string[] {
  const path: string[] = [];
  let current: ts.Node = identifier;

  while (ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current) {
    path.push(current.parent.name.text);
    current = current.parent;
  }

  return path;
}

/**
 * Whether a value holds the mock `root`: names it (on a compatible member path, so `{ save: h.save }` holds
 * `h.save` but not `h.load`), or names a local of the same file whose value does.
 */
function holdsMockRoot(value: ts.Node, root: MockReference, checker: ts.TypeChecker, depth = 0): boolean {
  for (const item of [value, ...descendants(value)]) {
    if (!ts.isIdentifier(item)) continue;
    const symbol = valueSymbol(item, checker);

    if (!symbol) continue;

    if (symbol === root.symbol) {
      const used = usedPath(item);
      const shorter = Math.min(used.length, root.path.length);

      if (used.slice(0, shorter).join('.') === root.path.slice(0, shorter).join('.')) return true;
      continue;
    }
    const initializer = variableInitializer(symbol.valueDeclaration);

    if (
      depth < 4 &&
      initializer &&
      initializer.getSourceFile() === value.getSourceFile() &&
      !contains(initializer, value) &&
      holdsMockRoot(initializer, root, checker, depth + 1)
    )
      return true;
  }

  return false;
}

/** A way project code could reach a mock or the page without being handed it, with a label for reports. */
type Route = { label: string } & (
  | { kind: 'module'; file: string }
  | { kind: 'global'; name: string }
  | { kind: 'member'; symbol: ts.Symbol }
);

/**
 * What code reads, followed through the functions, components and values it names: globals (`document`, `fetch`,
 * and members of `window` or `globalThis` such as `monaco`), the members it accesses (by symbol, so `Math.log` is not
 * `console.log`), and the modules of the imports it uses. Writes (`window.monaco = …`) are not reads.
 */
interface Reach {
  globals: Set<string>;
  /** Members by their declaration (`memberKey`): an inherited member is the same one whatever the receiver's type. */
  members: Set<ts.Node | ts.Symbol>;
  modules: Set<string>;
}

function memberKey(symbol: ts.Symbol): ts.Node | ts.Symbol {
  return symbol.declarations?.[0] ?? symbol;
}

function routeReached(route: Route, reach: Reach): boolean {
  return route.kind === 'module'
    ? reach.modules.has(route.file)
    : route.kind === 'global'
      ? reach.globals.has(route.name)
      : reach.members.has(memberKey(route.symbol));
}

function isWritten(node: ts.Expression): boolean {
  const parent = node.parent;

  return (
    (ts.isBinaryExpression(parent) &&
      parent.left === node &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) ||
    ts.isDeleteExpression(parent)
  );
}

/**
 * Walk code from `starts`, following declarations it names: in project files with `followProject`, otherwise in
 * test code only (helpers), which is what the test itself does.
 */
function codeReach(starts: ts.Node[], ctx: Ctx, followProject: boolean): Reach {
  const { checker } = ctx;
  const reach: Reach = { globals: new Set(), members: new Set(), modules: new Set() };
  const visited = new Set<ts.Node>();
  const follow = (symbol: ts.Symbol | undefined, depth: number) => {
    for (const declaration of symbol?.declarations ?? []) {
      const sourceFile = declaration.getSourceFile();

      if (sourceFile.isDeclarationFile) continue;
      const inProject = ctx.projectSet.has(path.resolve(sourceFile.fileName));

      if (followProject ? inProject : !inProject && isTestCodeFile(sourceFile, ctx))
        visit(declaration, depth + 1);
    }
  };
  const visit = (start: ts.Node, depth: number) => {
    if (visited.has(start) || depth > 12) return;
    visited.add(start);

    // Types run nothing: their subtrees, and interfaces or type aliases, are not walked.
    const nodes: ts.Node[] = [];
    const collect = (node: ts.Node) => {
      if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
      nodes.push(node);
      ts.forEachChild(node, collect);
    };
    collect(start);

    for (const node of nodes) {
      // A module loaded on demand (`await import('mermaid')`) is used by the code that loads it.
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = literalString(node.arguments[0]);
        const file =
          specifier === undefined
            ? undefined
            : resolvedModuleFile(specifier, node.getSourceFile().fileName, ctx);

        if (file !== undefined) reach.modules.add(file);
        continue;
      }

      if (ts.isPropertyAccessExpression(node)) {
        if (isWritten(node)) continue;
        const member = checker.getSymbolAtLocation(node.name);

        if (member) {
          reach.members.add(memberKey(member));
          follow(member, depth);
        }
        const holder = unwrapExpression(node.expression);

        if (ts.isIdentifier(holder) && GLOBAL_HOLDERS.has(holder.text) && isGlobalIdentifier(holder, checker))
          reach.globals.add(node.name.text);
        continue;
      }

      if (!ts.isIdentifier(node)) continue;
      const parent = node.parent;

      if (
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node)
      )
        continue;
      let symbol = checker.getSymbolAtLocation(node);
      const declarations = symbol?.declarations ?? [];

      if (!symbol || declarations.length === 0) continue;

      if (declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile)) {
        reach.globals.add(node.text);
        continue;
      }

      if (symbol.flags & ts.SymbolFlags.Alias) {
        let importNode: ts.Node | undefined = declarations[0];

        while (importNode && !ts.isImportDeclaration(importNode)) importNode = importNode.parent;
        const specifier =
          importNode && ts.isImportDeclaration(importNode)
            ? literalString(importNode.moduleSpecifier)
            : undefined;
        const file =
          specifier === undefined
            ? undefined
            : resolvedModuleFile(specifier, node.getSourceFile().fileName, ctx);

        if (file !== undefined) reach.modules.add(file);
        symbol = checker.getAliasedSymbol(symbol);
      }

      // A parameter or local of the code being walked adds nothing by itself.
      if (declarations.some((declaration) => contains(start, declaration))) continue;
      follow(symbol, depth);
    }
  };

  for (const start of starts) visit(start, 0);

  return reach;
}

/** Reach of a project symbol (`file#name`), from its declaration. */
const projectReachCache = new Map<string, Reach>();

function projectReach(symbol: string, ctx: Ctx): Reach {
  const cached = projectReachCache.get(symbol);

  if (cached) return cached;
  const index = symbol.lastIndexOf('#');
  const sourceFile =
    index > 0 ? ctx.program.getSourceFile(path.resolve(ctx.root, symbol.slice(0, index))) : undefined;
  const moduleSymbol = sourceFile && ctx.checker.getSymbolAtLocation(sourceFile);
  let exported = moduleSymbol
    ? ctx.checker.getExportsOfModule(moduleSymbol).find((item) => item.getName() === symbol.slice(index + 1))
    : undefined;

  if (exported && exported.flags & ts.SymbolFlags.Alias) exported = ctx.checker.getAliasedSymbol(exported);
  const name = symbol.slice(index + 1);
  // A symbol id names an export, a default export by its local name, or a member (`storeApi.saveLanguage` is
  // `storeApi.ts#saveLanguage`): find the declarations of that name in the file.
  const declarations =
    exported?.declarations ??
    (sourceFile ? descendants(sourceFile) : []).filter(
      (node) =>
        (ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isVariableDeclaration(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isPropertyAssignment(node) ||
          ts.isPropertyDeclaration(node)) &&
        node.name !== undefined &&
        ts.isIdentifier(node.name) &&
        node.name.text === name,
    );
  const reach = codeReach(declarations, ctx, true);
  projectReachCache.set(symbol, reach);

  return reach;
}

/**
 * What a test body does itself: the functions, globals and members it calls directly, and everything the helpers of
 * the test code it calls read. A route the test uses this way may be how the calls or writes it checks were made.
 */
function testSideReach(body: ts.Node | undefined, ctx: Ctx): Reach {
  const { checker } = ctx;
  const reach: Reach = { globals: new Set(), members: new Set(), modules: new Set() };

  if (!body) return reach;
  const helpers: ts.Node[] = [];

  for (const node of descendants(body)) {
    if (!ts.isCallExpression(node)) continue;
    const callee = unwrapExpression(node.expression);
    const named = ts.isPropertyAccessExpression(callee)
      ? callee.name
      : ts.isIdentifier(callee)
        ? callee
        : undefined;

    if (!named) continue;
    // What is called, not what its receiver or arguments compute (`expect(send)` does not call `send`).
    const base = ts.isPropertyAccessExpression(callee) ? unwrapExpression(callee.expression) : named;

    if (ts.isPropertyAccessExpression(callee)) {
      const member = checker.getSymbolAtLocation(callee.name);

      if (member) reach.members.add(memberKey(member));

      if (ts.isIdentifier(base) && GLOBAL_HOLDERS.has(base.text) && isGlobalIdentifier(base, checker))
        reach.globals.add(callee.name.text);
    }

    if (ts.isIdentifier(base)) {
      const baseSymbol = checker.getSymbolAtLocation(base);
      const declarations = baseSymbol?.declarations ?? [];

      if (
        base === named &&
        declarations.length > 0 &&
        declarations.every((item) => item.getSourceFile().isDeclarationFile)
      )
        reach.globals.add(base.text);
      let importNode: ts.Node | undefined =
        baseSymbol && baseSymbol.flags & ts.SymbolFlags.Alias ? declarations[0] : undefined;

      while (importNode && !ts.isImportDeclaration(importNode)) importNode = importNode.parent;
      const specifier =
        importNode && ts.isImportDeclaration(importNode)
          ? literalString(importNode.moduleSpecifier)
          : undefined;
      const file =
        specifier === undefined
          ? undefined
          : resolvedModuleFile(specifier, base.getSourceFile().fileName, ctx);

      if (file !== undefined) reach.modules.add(file);
    }
    let symbol = checker.getSymbolAtLocation(named);

    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);

    for (const declaration of symbol?.declarations ?? []) {
      const sourceFile = declaration.getSourceFile();

      if (
        !sourceFile.isDeclarationFile &&
        !ctx.projectSet.has(path.resolve(sourceFile.fileName)) &&
        isTestCodeFile(sourceFile, ctx) &&
        !contains(body, declaration)
      )
        helpers.push(declaration);
    }
  }
  const helped = codeReach(helpers, ctx, false);

  for (const item of helped.globals) reach.globals.add(item);

  for (const item of helped.members) reach.members.add(item);

  for (const item of helped.modules) reach.modules.add(item);

  return reach;
}

/** A module file for reports: relative to the root, or from the package name for a dependency. */
function moduleLabel(file: string, ctx: Ctx): string {
  const relative = toPosixRelative(ctx.root, file);
  const index = relative.lastIndexOf('node_modules/');

  return index < 0 ? relative : relative.slice(index + 'node_modules/'.length);
}

/**
 * How project code could reach a mock the test checks without being handed it: through a module the file mocks (an
 * import from it, its mock factory or a mocked function's result holding the mock), a global holding it
 * (`window.monaco`, `vi.stubGlobal`), or the global API a spy watches (`Element.prototype.scrollIntoView`).
 */
function mockRoutes(root: MockReference & { identifier: ts.Identifier }, ctx: Ctx): Route[] {
  const { checker } = ctx;
  const routes: Route[] = [];
  const moduleRoute = (file: string) => {
    if (!routes.some((route) => route.kind === 'module' && route.file === file))
      routes.push({ kind: 'module', file, label: `mocked module ${moduleLabel(file, ctx)}` });
  };
  const imported = mockedModuleOf(root.identifier, ctx);

  if (imported !== undefined) moduleRoute(imported);
  const source = root.identifier.getSourceFile();
  const declaration = root.symbol.valueDeclaration;
  // A local naming an export of a mocked module (`const render = vi.mocked(mermaid.render)`, `const send = api.send`).
  let alias =
    variableInitializer(declaration) && unwrapExpression(variableInitializer(declaration) as ts.Expression);

  if (alias && ts.isCallExpression(alias) && mockCall(alias, checker) !== undefined && alias.arguments[0])
    alias = unwrapExpression(alias.arguments[0]);

  while (alias && ts.isPropertyAccessExpression(alias)) alias = unwrapExpression(alias.expression);
  const aliased = alias && ts.isIdentifier(alias) ? mockedModuleOf(alias, ctx) : undefined;

  if (aliased !== undefined) moduleRoute(aliased);
  // A spy on a global object or prototype (`vi.spyOn(Element.prototype, 'scrollIntoView')`), kept in a local.
  const values = [
    ...(variableInitializer(declaration) ? [variableInitializer(declaration) as ts.Expression] : []),
    ...assignmentsTo(root.symbol, source, checker),
  ];

  for (const value of values) {
    let call = unwrapExpression(value);

    // `vi.spyOn(...).mockImplementation(...)` configures the spy and returns it.
    while (
      ts.isCallExpression(call) &&
      ts.isPropertyAccessExpression(call.expression) &&
      mockCall(call, checker) === undefined &&
      ts.isCallExpression(unwrapExpression(call.expression.expression))
    )
      call = unwrapExpression(call.expression.expression);

    if (!ts.isCallExpression(call) || mockCall(call, checker) !== 'spy') continue;
    const [object, nameNode] = call.arguments;
    const name = literalString(nameNode);
    let base = object && unwrapExpression(object);

    while (base && ts.isPropertyAccessExpression(base)) base = unwrapExpression(base.expression);

    if (
      !object ||
      name === undefined ||
      !base ||
      !ts.isIdentifier(base) ||
      !isGlobalIdentifier(base, checker)
    )
      continue;
    const member = checker.getTypeAtLocation(object).getProperty(name);

    if (member) routes.push({ kind: 'member', symbol: member, label: `spied ${object.getText()}.${name}` });
  }

  for (const holder of fileMockHolders(source, ctx))
    if (holdsMockRoot(holder.value, root, checker)) {
      if (holder.module !== undefined) moduleRoute(holder.module);

      if (
        holder.global !== undefined &&
        !routes.some((route) => route.kind === 'global' && route.name === holder.global)
      )
        routes.push({ kind: 'global', name: holder.global, label: `global ${holder.global}` });
    }

  return routes;
}

/** Project symbols exported by the module a `vi.mock(specifier)` call replaces. */
function moduleExports(argument: ts.Expression | undefined, ctx: Ctx): string[] {
  if (!argument) return [];
  let specifierNode = skipParens(argument);

  if (
    ts.isCallExpression(specifierNode) &&
    specifierNode.expression.kind === ts.SyntaxKind.ImportKeyword &&
    specifierNode.arguments[0]
  )
    specifierNode = specifierNode.arguments[0];
  const specifier = literalString(specifierNode);

  if (specifier === undefined) return [];
  const resolved = ts.resolveModuleName(specifier, ctx.file, ctx.compilerOptions, ts.sys).resolvedModule;
  const sourceFile = resolved && ctx.program.getSourceFile(resolved.resolvedFileName);
  const moduleSymbol = sourceFile && ctx.checker.getSymbolAtLocation(sourceFile);

  if (!moduleSymbol) return [];

  return ctx.checker
    .getExportsOfModule(moduleSymbol)
    .map((item) => projectSymbolId(item, ctx.checker, ctx.projectSet, ctx.root))
    .filter((id): id is string => id !== undefined);
}

/**
 * A mock applies to a test when it is inside that test's body, is a hoisted `vi.mock`, or sits
 * outside every test body (module level or a describe/hook) within describes enclosing the test.
 */
function mockApplies(
  mock: MockRecord,
  registrationCall: ts.CallExpression,
  callback: ts.Node | undefined,
): boolean {
  if (mock.fileWide) return true;

  if (callback && contains(callback, mock.node)) return true;

  for (let current: ts.Node | undefined = mock.node.parent; current; current = current.parent) {
    if (!ts.isCallExpression(current)) continue;
    const test = testRegistration(current);

    if (test?.callback && isFunction(test.callback) && contains(test.callback, mock.node)) return false;
    const suite = describeRegistration(current);

    if (suite?.callback && contains(suite.callback, mock.node) && !contains(suite.callback, registrationCall))
      return false;
  }

  return true;
}

function isAssertionCountCall(node: ts.CallExpression): boolean {
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    ['assertions', 'hasAssertions'].includes(node.expression.name.text)
  );
}

/** Values an assertion compares: the expect subject plus matcher arguments, or assert.* arguments. */
function comparedValues(assertion: ts.CallExpression): ts.Expression[] {
  const values = [...assertion.arguments];

  if (!isExpectCall(assertion)) return values;
  let current: ts.Node = assertion;

  while (ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current)
    current = current.parent;

  if (current !== assertion && ts.isCallExpression(current.parent) && current.parent.expression === current)
    values.push(...current.parent.arguments);

  return values;
}

/** Literals, and `const` bindings initialised with constants, recursively. */
function isCompileTimeConstant(node: ts.Expression, checker: ts.TypeChecker, depth = 0): boolean {
  if (depth > 20) return false;
  const expression = skipParens(node);

  if (literalArgument(expression) !== null) return true;

  if (ts.isNoSubstitutionTemplateLiteral(expression) || ts.isRegularExpressionLiteral(expression))
    return true;

  if (ts.isPrefixUnaryExpression(expression))
    return isCompileTimeConstant(expression.operand, checker, depth + 1);

  if (ts.isArrayLiteralExpression(expression))
    return expression.elements.every(
      (element) => !ts.isSpreadElement(element) && isCompileTimeConstant(element, checker, depth + 1),
    );

  if (ts.isObjectLiteralExpression(expression))
    return expression.properties.every(
      (property) =>
        ts.isPropertyAssignment(property) &&
        !ts.isComputedPropertyName(property.name) &&
        isCompileTimeConstant(property.initializer, checker, depth + 1),
    );

  if (ts.isIdentifier(expression)) {
    if (expression.text === 'undefined') return true;
    const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;

    return Boolean(
      declaration &&
        ts.isVariableDeclaration(declaration) &&
        ts.isVariableDeclarationList(declaration.parent) &&
        declaration.parent.flags & ts.NodeFlags.Const &&
        declaration.initializer &&
        isCompileTimeConstant(declaration.initializer, checker, depth + 1) &&
        !mayBeChanged(expression, declaration.initializer, checker),
    );
  }

  return false;
}

/**
 * Whether the array or object a `const` holds may change after it is created: a method is called on it
 * (`result.push(x)`), one of its elements or properties is assigned, or it is passed to a function, which may do
 * either. Such a value is not a compile-time constant even though its initializer is a literal.
 */
function mayBeChanged(
  identifier: ts.Identifier,
  initializer: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  const value = skipParens(initializer);

  if (!ts.isArrayLiteralExpression(value) && !ts.isObjectLiteralExpression(value)) return false;
  const symbol = checker.getSymbolAtLocation(identifier);

  return descendants(identifier.getSourceFile()).some((node) => {
    if (!ts.isIdentifier(node) || node === identifier || checker.getSymbolAtLocation(node) !== symbol)
      return false;
    let use: ts.Node = node;

    while (ts.isParenthesizedExpression(use.parent)) use = use.parent;
    const parent = use.parent;

    // Passing it to an assertion (`expect(x)`, `.toEqual(x)`, `assert.equal(x, ...)`) only reads it.
    if (ts.isCallExpression(parent) && isAssertionChainCall(parent)) return false;

    if (
      (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
      parent.arguments?.includes(use as ts.Expression)
    )
      return true;

    if (
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === use
    ) {
      const outer = parent.parent;

      return (
        (ts.isCallExpression(outer) && outer.expression === parent) ||
        (ts.isBinaryExpression(outer) &&
          outer.left === parent &&
          outer.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          outer.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
        ts.isDeleteExpression(outer)
      );
    }

    return false;
  });
}

/** `expect(...)`, `assert...(...)` or a matcher chained on them (`expect(a).not.toEqual(b)`). */
function isAssertionChainCall(call: ts.CallExpression): boolean {
  let current: ts.Expression = call;

  while (
    ts.isCallExpression(current) ||
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    if (ts.isCallExpression(current) && (isExpectCall(current) || isAssertCall(current))) return true;
    current = current.expression;
  }

  return false;
}

function skipParens(node: ts.Expression): ts.Expression {
  let current = node;

  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current)
  )
    current = current.expression;

  return current;
}

function nondeterminismFor(node: ts.Node, fakeTimers: boolean): string[] {
  const text = node.getText();

  if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return [];
  const values: string[] = [];

  if (text.includes('Math.random')) values.push('Math.random');

  if (text.includes('Date.now')) values.push('Date.now');

  if (ts.isNewExpression(node) && text.startsWith('new Date') && node.arguments?.length === 0)
    values.push('new Date()');

  if (text.includes('crypto.randomUUID')) values.push('crypto.randomUUID');

  if (!fakeTimers && /\b(setTimeout|setInterval|setImmediate|queueMicrotask)\s*\(/.test(text))
    values.push('timer');

  return values;
}

function callsHelperWithAssertion(body: ts.Node | undefined, source: ts.SourceFile): boolean {
  if (!body) return false;
  const names = new Set<string>();

  for (const node of descendants(body))
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) names.add(node.expression.text);
  let found = false;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text)) {
      found ||= descendants(node).some(
        (child) => ts.isCallExpression(child) && (isExpectCall(child) || isAssertCall(child)),
      );
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      names.has(node.name.text) &&
      node.initializer
    ) {
      found ||= descendants(node.initializer).some(
        (child) => ts.isCallExpression(child) && (isExpectCall(child) || isAssertCall(child)),
      );
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);

  return found;
}

/**
 * Function declarations of the file (`function f(...)`, or the declaration of `const f = (...) =>`) mapped to the
 * parameter positions that the subject of one of their assertions refers to, without comparing it with itself.
 */
const assertingHelpersCache = new WeakMap<ts.SourceFile, Map<ts.Node, Set<number>>>();

function assertingHelpers(source: ts.SourceFile): Map<ts.Node, Set<number>> {
  const cached = assertingHelpersCache.get(source);
  if (cached) return cached;
  const helpers = new Map<ts.Node, Set<number>>();
  const names = (node: ts.Node) =>
    new Set([node, ...descendants(node)].filter(ts.isIdentifier).map((identifier) => identifier.text));
  const record = (declaration: ts.Node, fn: ts.SignatureDeclaration & { body?: ts.Node }) => {
    if (!fn.body) return;
    const params = fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : undefined));
    const positions = new Set<number>();
    for (const child of descendants(fn.body)) {
      if (!ts.isCallExpression(child) || !(isExpectCall(child) || isAssertCall(child))) continue;
      if (isAssertionCountCall(child)) continue;
      const [subject, ...expected] = comparedValues(child);
      if (!subject) continue;
      const inSubject = names(subject);
      const inExpected = new Set(expected.flatMap((value) => [...names(value)]));
      params.forEach((param, index) => {
        // Comparing a parameter with itself (`expect(v).toBe(v)`) always holds and asserts nothing.
        if (param !== undefined && inSubject.has(param) && !inExpected.has(param)) positions.add(index);
      });
    }
    if (positions.size > 0) helpers.set(declaration, positions);
  };
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) record(node, node);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isFunction(node.initializer)
    )
      record(node, node.initializer);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  assertingHelpersCache.set(source, helpers);
  return helpers;
}

/** Names chained on an assertion: `expect(x).not.toThrow(e)` gives `not`, `toThrow`. */
function matcherNames(assertion: ts.CallExpression): string[] {
  const names: string[] = [];

  for (let current: ts.Node = assertion; ; ) {
    const parent = current.parent;

    if (ts.isPropertyAccessExpression(parent) && parent.expression === current) {
      names.push(parent.name.text);
      current = parent;
    } else if (ts.isCallExpression(parent) && parent.expression === current) current = parent;
    else if (ts.isAwaitExpression(parent)) current = parent;
    else return names;
  }
}

/** Whether a file renders JSX with a runtime inside the project: an `@jsxImportSource` pragma with a relative path. */
function projectJsxRuntime(source: ts.SourceFile): boolean {
  return /@jsxImportSource\s+\.{1,2}(?:[\\/]\S*)?(?:\s|\*)/.test(source.text.slice(0, 2000));
}

/** The function a local `const name = () => ...` (or `function name() {}`) of this file holds. */
function localFunction(value: ts.Expression, checker: ts.TypeChecker): ts.Node | undefined {
  if (!ts.isIdentifier(value)) return undefined;
  const declaration = checker.getSymbolAtLocation(value)?.valueDeclaration;

  if (!declaration || declaration.getSourceFile() !== value.getSourceFile()) return undefined;
  const fn =
    ts.isVariableDeclaration(declaration) && declaration.initializer
      ? skipParens(declaration.initializer)
      : declaration;

  return isFunctionLike(fn) ? fn : undefined;
}

/** Assertion methods of a test context object, as AVA and tap name them, plus Vitest's `context.expect`. */
const CONTEXT_ASSERTIONS = new Set([
  'is',
  'not',
  'true',
  'false',
  'truthy',
  'falsy',
  'deepEqual',
  'notDeepEqual',
  'like',
  'notLike',
  'throws',
  'throwsAsync',
  'notThrows',
  'notThrowsAsync',
  'regex',
  'notRegex',
  'assert',
  'ok',
  'notOk',
  'equal',
  'notEqual',
  'strictEqual',
  'notStrictEqual',
  'same',
  'notSame',
  'match',
  'expect',
]);

/** `t.is(a, b)` or `ctx.expect(a)` where `t`/`ctx` is the test callback's first parameter. */
function isContextAssertion(
  node: ts.CallExpression,
  parameter: ts.Symbol | undefined,
  checker: ts.TypeChecker,
) {
  const callee = node.expression;

  return (
    parameter !== undefined &&
    ts.isPropertyAccessExpression(callee) &&
    CONTEXT_ASSERTIONS.has(callee.name.text) &&
    ts.isIdentifier(callee.expression) &&
    checker.getSymbolAtLocation(callee.expression) === parameter
  );
}

const TYPE_CHECK_NAMES = /\b(?:Expect|Equal|IsEqual|IsExact|AssertTrue|AssertFalse|AssertEqual|Assert)\b/;

/** A type alias that states a type check, or a call with type arguments to an assert/expect helper. */
function hasTypeOnlyCheck(body: ts.Node): boolean {
  // A body that only declares functions and types, and runs none of them, checks that they compile.
  if (
    ts.isBlock(body) &&
    body.statements.length > 0 &&
    body.statements.every(
      (statement) =>
        ts.isFunctionDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement),
    )
  )
    return true;

  return descendants(body).some(
    (node) =>
      (ts.isTypeAliasDeclaration(node) && TYPE_CHECK_NAMES.test(node.type.getText())) ||
      (ts.isCallExpression(node) &&
        node.typeArguments !== undefined &&
        node.typeArguments.length > 0 &&
        /(?:assert|expect)/i.test(calleeName(node.expression)) &&
        // `assertEqual<A, B>(true)` checks types; `expectValue<number>(calculate())` checks a runtime value.
        node.arguments.every((argument) => literalArgument(skipParens(argument)) !== null)),
  );
}

function calleeName(expression: ts.Expression): string {
  return ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : ts.isIdentifier(expression)
      ? expression.text
      : '';
}

/**
 * Whether a test is registered inside a function other than a describe, test or hook callback (a shared suite such
 * as `export const renderTest = (getEnv) => { ... }`, or `runTest(name, fn, cases)`), and its body uses a parameter of
 * that function or a value declared in it.
 */
function usesSuiteParameters(
  registrationCall: ts.CallExpression,
  body: ts.Node,
  checker: ts.TypeChecker,
): boolean {
  let suite: ts.Node | undefined;

  for (
    let current: ts.Node = registrationCall.parent;
    current && !ts.isSourceFile(current);
    current = current.parent
  ) {
    if (!isFunctionLike(current)) continue;
    const call = current.parent;
    const registers =
      ts.isCallExpression(call) &&
      call.arguments.includes(current as ts.Expression) &&
      (describeRegistration(call) !== undefined ||
        testRegistration(call) !== undefined ||
        (ts.isIdentifier(call.expression) && runner.hooks.has(call.expression.text)));

    if (!registers) {
      suite = current;
      break;
    }
  }

  if (!suite || !isFunctionLike(suite)) return false;
  // The suite's parameters, and the locals of the suite set from them (`const { css } = getEnv()`, or assigned in a
  // hook: `({ css } = getEnv())`), are what its caller supplies.
  const supplied = new Set<ts.Symbol>();

  for (const parameter of suite.parameters)
    for (const identifier of bindingIdentifiers(parameter.name)) {
      const symbol = checker.getSymbolAtLocation(identifier);
      if (symbol) supplied.add(symbol);
    }
  const refersToSupplied = (node: ts.Node) =>
    [node, ...descendants(node)].some((item) => {
      if (!ts.isIdentifier(item)) return false;
      const symbol = checker.getSymbolAtLocation(item);

      return symbol !== undefined && supplied.has(symbol);
    });

  for (let changed = true; changed; ) {
    changed = false;

    for (const node of descendants(suite)) {
      let targets: ts.Identifier[] = [];

      if (ts.isVariableDeclaration(node) && node.initializer && refersToSupplied(node.initializer))
        targets = bindingIdentifiers(node.name);
      else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        refersToSupplied(node.right)
      )
        targets = [node.left, ...descendants(node.left)].filter(ts.isIdentifier);

      for (const identifier of targets) {
        // In `({ css } = getEnv())` the shorthand names the variable assigned, not the property.
        const symbol = ts.isShorthandPropertyAssignment(identifier.parent)
          ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
          : checker.getSymbolAtLocation(identifier);
        const declaration = symbol?.valueDeclaration;

        if (symbol && declaration && contains(suite, declaration) && !supplied.has(symbol)) {
          supplied.add(symbol);
          changed = true;
        }
      }
    }
  }

  return refersToSupplied(body);
}

/**
 * The test runner's type-level checks (`expectTypeOf`, `assertType`), which compare types at compile time and do
 * nothing when the test runs.
 */
function isTypeLevelAssertion(node: ts.CallExpression): boolean {
  const root = rootIdentifier(node.expression);

  return root !== undefined && runner.typeLevel.has(root);
}

/** `expect(...)`, and the test runner's type-level checks (`expectTypeOf(...)`, `assertType(...)`). */
function isExpectCall(node: ts.CallExpression): boolean {
  const root = rootIdentifier(node.expression);

  return root !== undefined && (runner.expect.has(root) || runner.typeLevel.has(root));
}

/** `assert.equal(a, b)` on one of the runner's assertion objects, or `expect.assertions(n)` on anything. */
function isAssertCall(node: ts.CallExpression): boolean {
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    (runner.assertObjects.has(node.expression.expression.getText()) ||
      runner.assertionCounts.has(node.expression.name.text))
  );
}

function rootIdentifier(expression: ts.Expression): string | undefined {
  let current = expression;

  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current))
    current = current.expression;

  return ts.isIdentifier(current) ? current.text : undefined;
}

function propertyChain(expression: ts.Expression): string[] {
  const chain: string[] = [];
  let current = expression;

  while (ts.isPropertyAccessExpression(current)) {
    chain.push(current.name.text);
    current = current.expression;
  }

  return chain;
}

function descendants(node: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  const visit = (current: ts.Node) => {
    result.push(current);
    ts.forEachChild(current, visit);
  };
  ts.forEachChild(node, visit);

  return result;
}

function contains(parent: ts.Node, child: ts.Node): boolean {
  return child.getStart() >= parent.getStart() && child.getEnd() <= parent.getEnd();
}

function location(
  source: ts.SourceFile,
  node: ts.Node,
  file: string,
): { file: string; range: { start: number; end: number } } {
  return {
    file,
    range: {
      start: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      end: source.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
    },
  };
}

/**
 * Source text of a literal argument, or null. Numeric literals are normalised to decimal
 * (`0x10` -> `'16'`), a leading `-`/`+` on a numeric or bigint literal is folded in (`-1` -> `'-1'`),
 * and parentheses are ignored.
 */
/**
 * The literal text of a call argument, or null. Arrays and object literals of number/boolean literals are
 * recorded as JSON with numbers as decimal strings (`["1","2"]`, `{"total":"1000","vip":true}`), so they stay exact.
 */
function literalArgument(input: ts.Expression): string | null {
  const node = skipParens(input);
  const scalar = (e: ts.Expression): string | boolean | null => {
    const text = literalArgument(e);

    if (text === 'true' || text === 'false') return text === 'true';

    return text !== null && /^-?\d+(?:\.\d+)?$/.test(text) ? text : null;
  };

  if (ts.isArrayLiteralExpression(node)) {
    const values = node.elements.map((e) => (ts.isSpreadElement(e) ? null : scalar(e)));

    return values.every((v) => v !== null) ? JSON.stringify(values) : null;
  }

  if (ts.isObjectLiteralExpression(node)) {
    const out: Record<string, string | boolean> = {};

    for (const prop of node.properties) {
      if (!ts.isPropertyAssignment(prop)) return null;
      const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
      const value = scalar(prop.initializer);

      if (key === null || value === null) return null;
      out[key] = value;
    }

    return JSON.stringify(out);
  }
  // `text` is the value as a double; plain decimal digits are kept as written so large integers stay exact.
  const digits = (n: ts.NumericLiteral) => (/^\d+$/.test(n.getText()) ? n.getText() : n.text);

  if (ts.isNumericLiteral(node)) return digits(node);

  if (ts.isBigIntLiteral(node)) return node.text;

  if (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken)
  ) {
    const operand = skipParens(node.operand);

    if (!ts.isNumericLiteral(operand) && !ts.isBigIntLiteral(operand)) return null;
    const text = ts.isNumericLiteral(operand) ? digits(operand) : operand.text;

    return node.operator === ts.SyntaxKind.MinusToken ? `-${text}` : text;
  }

  return ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
    ? node.getText()
    : null;
}

function literalString(node: ts.Node | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function isFunction(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function isSourceFile(file: string): boolean {
  return /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/.test(file);
}

function collectFiles(root: string, includes: string[], excludes: string[]): string[] {
  const result: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const file = path.join(dir, entry.name);

      if (entry.isDirectory()) walk(file);
      // Links are not followed: one could point outside the project root.
      else if (entry.isFile() && isSourceFile(file)) {
        const relative = toPosixRelative(root, file);

        if (
          includes.some((pattern) =>
            expandBraces(pattern).some((expanded) => globMatches(relative, expanded)),
          ) &&
          !excludes.some((pattern) =>
            expandBraces(pattern).some((expanded) => globMatches(relative, expanded)),
          )
        )
          result.push(file);
      }
    }
  };
  walk(root);

  return result.sort();
}

function globMatches(file: string, pattern: string): boolean {
  const normalized = pattern.split('\\').join('/');
  let regex = '^';

  for (let index = 0; index < normalized.length; ) {
    if (normalized.startsWith('**/', index)) {
      regex += '(?:.*/)?';
      index += 3;
      continue;
    }

    if (normalized.startsWith('**', index)) {
      regex += '.*';
      index += 2;
      continue;
    }
    const character = normalized[index];

    if (character === undefined) break;

    if (character === '*') regex += '[^/]*';
    else if (character === '?') regex += '.';
    else regex += /[.+^${}()|[\]\\]/.test(character) ? `\\${character}` : character;
    index += 1;
  }

  return new RegExp(`${regex}$`).test(file);
}

function expandBraces(pattern: string): string[] {
  const start = pattern.indexOf('{');

  if (start < 0) return [pattern];
  const end = pattern.indexOf('}', start);

  if (end < 0) return [pattern];

  return pattern
    .slice(start + 1, end)
    .split(',')
    .flatMap((part) => expandBraces(`${pattern.slice(0, start)}${part}${pattern.slice(end + 1)}`));
}
// Bundler resolution, like Vitest's: extensionless relative imports resolve, and so do `.js` specifiers for `.ts` files.
const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2024,
  allowJs: true,
};

/**
 * Compiler options from the project's tsconfig. Only files inside the root are read: a configured tsconfig
 * outside it (or behind a link leaving it), an `extends` base outside it and parent directories are ignored.
 */
function readCompilerOptions(root: string, config: VeritasConfig): ts.CompilerOptions {
  const inside = (name: string) => {
    try {
      resolveInsideRoot(root, name);

      return true;
    } catch {
      return false;
    }
  };
  const configFile = path.resolve(root, config.project.tsconfig ?? 'tsconfig.json');

  if (!inside(configFile) || !ts.sys.fileExists(configFile)) return DEFAULT_COMPILER_OPTIONS;
  const parsed = ts.readConfigFile(configFile, ts.sys.readFile);

  if (parsed.error) return DEFAULT_COMPILER_OPTIONS;
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readDirectory: (dir, ...rest) => (inside(dir) ? ts.sys.readDirectory(dir, ...rest) : []),
    fileExists: (name) => inside(name) && ts.sys.fileExists(name),
    readFile: (name) => (inside(name) ? ts.sys.readFile(name) : undefined),
  };

  return ts.parseJsonConfigFileContent(parsed.config, host, path.dirname(configFile)).options;
}
