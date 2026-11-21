import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  resolveInsideRoot,
  sha256,
  stableId,
  symbolId,
  TestCase,
  type TestCase as TestCaseType,
  TestPropertyEdge,
  type TestPropertyEdge as TestPropertyEdgeType,
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

const modifiers = new Set(['skip', 'only', 'todo', 'concurrent', 'each']);
const testNames = new Set(['it', 'test']);

export function testId(file: string, suitePath: string[], name: string): string {
  return stableId('T', { file: file.split('\\').join('/'), suitePath, name });
}

export function inventoryTests(options: {
  root: string;
  config: VeritasConfig;
  files?: string[];
}): TestInventory {
  const root = path.resolve(options.root);
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

        return !source || !importsVitestRuntime(source);
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
}

/** Whether handing over `given` hands over the mock `read` checks: the whole value, or a property above it. */
function covers(given: MockReference, read: MockReference): boolean {
  return given.symbol === read.symbol && given.path.every((name, index) => read.path[index] === name);
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
  /** Mocks (or objects holding mocks) declared outside the body that the body hands to project calls, by call. */
  handed: Map<Invocation, MockReference[]>;
  /** Variables holding mocks or objects holding mocks, with the part handed over, by the calls they are handed to. */
  mockHolders: Map<Invocation, MockReference[]>;
  /** An assertion of the body (or of a helper it calls) checks a Testing Library query of the document. */
  observesDocument: boolean;
}

/**
 * Calls, assertions and result flow in a test body or helper body. Values are followed through local and
 * enclosing (describe-level or module-level) variables of the same file, including `let` set in a hook.
 */
function analyzeBody(
  body: ts.Node,
  ctx: Ctx,
  contextAssertion: (node: ts.CallExpression) => boolean = () => false,
): BodyAnalysis {
  const { checker } = ctx;
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
    const info = callInfo(node, ctx);

    if (!recorded.has(node)) {
      recorded.add(node);

      for (const target of info.targets) calls.push({ node, target });
      helperAsserts ||= info.helperAsserts;
      opaque ||= info.opaque;

      if (info.observesDocument) documentChecks.push(node.getEnd());
    }

    return info.targets.length > 0;
  };
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
    let sources = sourcesOf(expressions);
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
    for (const { declaration, path } of [
      ...holders.mocks.map((declaration) => ({ declaration, path: [] as string[] })),
      ...holders.containers,
    ]) {
      if (declaration.getSourceFile() !== source) continue;

      for (const identifier of bindingIdentifiers(declaration.name)) {
        const symbol = checker.getSymbolAtLocation(identifier);

        if (!symbol) continue;
        mockHolders.set(call, [...(mockHolders.get(call) ?? []), { symbol, path }]);

        // A mock of an enclosing scope that a helper hands over (`const renderDialog = () => render(<Dialog
        // onSave={onSave} />)`) is checked where the helper is called, which this body's caller sees.
        if (!contains(body, declaration)) handed.set(call, [...(handed.get(call) ?? []), { symbol, path }]);
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

  for (const node of descendants(body)) {
    if (ts.isTryStatement(node) && node.catchClause?.variableDeclaration)
      bind(
        bindingIdentifiers(node.catchClause.variableDeclaration.name),
        descendants(node.tryBlock).filter((item): item is Invocation => isInvocation(item) && record(item)),
      );

    if (ts.isVariableDeclaration(node) && node.initializer)
      bind(bindingIdentifiers(node.name), sourcesOf([node.initializer]));

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    )
      bind([node.left], sourcesOf([node.right]));

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

  // Mocks the body calls itself (`onSave(); expect(onSave).toHaveBeenCalled()`): a call count on them may count the
  // test's own calls, so it is not taken as checking project code.
  const selfCalled: MockReference[] = [];

  for (const node of descendants(body))
    if (ts.isCallExpression(node) && !inNestedFunction(node, body)) {
      const reference = mockReference(node.expression, checker);

      if (reference) selfCalled.push(reference);
    }
  const checksSelfCalled = (assertion: ts.CallExpression): boolean => {
    const subject = assertion.arguments[0];

    if (
      !subject ||
      !isExpectCall(assertion) ||
      !matcherNames(assertion).some((name) => MOCK_MATCHER.test(name))
    )
      return false;
    const reference = mockReference(subject, checker);

    return (
      reference !== undefined &&
      selfCalled.some(
        (called) => called.symbol === reference.symbol && called.path.join('.') === reference.path.join('.'),
      )
    );
  };

  // Either side of a comparison counts: `expect(['a', 'b']).toContain(result.status)` checks the result.
  for (const assertion of assertions) {
    if (checksSelfCalled(assertion)) continue;

    const runsSubject = matcherNames(assertion).some((name) => name.startsWith('toThrow'));

    for (const value of comparedValues(assertion)) {
      for (const call of trackedCalls(value)) asserted.add(call);

      for (const { node } of calls) if (contains(value, node)) asserted.add(node);

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

  // `document.body.className = 'dark'`: what the test writes to the page itself is not what a component rendered.
  const documentWrites = descendants(body)
    .filter(
      (node): node is ts.BinaryExpression =>
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        documentChain(node.left, checker) !== undefined,
    )
    .map((node) => ({ chain: documentChain(node.left, checker) as string, end: node.getEnd() }));

  for (const assertion of assertions) {
    if (checksSelfCalled(assertion)) continue;
    const reached = assertionReach(assertion, checker, documentWrites);

    // Where the page was read: a query kept in a local before the render (`const before = screen.queryByText('x');
    // render(<Dialog />); expect(before)…`) did not see what rendered after it.
    documentChecks.push(...reached.documentReads);

    for (const root of reached.mockRoots) {
      const results = new Set(trackedCalls(root.identifier));

      for (const entry of calls)
        if (
          entry.target.observedBy?.some((given) => covers(given, root)) ||
          mockHolders.get(entry.node)?.some((given) => covers(given, root)) ||
          (entry.target.returnsMocks && results.has(entry.node))
        )
          observed.add(entry);
    }
  }

  for (const entry of calls)
    if (
      entry.target.rendered &&
      !entry.target.passThrough &&
      documentChecks.some((position) => entry.node.getStart() < position)
    )
      observed.add(entry);
  const awaitedProject = awaited.filter((node) => sourcesOf([node.expression]).length > 0);
  const checks = assertions.filter(
    (assertion) => !isAssertionCountCall(assertion) && !isTypeLevelAssertion(assertion),
  );
  const progressOnly =
    asserted.size === 0 &&
    awaitedProject.length > 0 &&
    checks.length > 0 &&
    recordsProgress(checks, body, Math.min(...awaitedProject.map((node) => node.getEnd())), checker);

  return {
    calls,
    assertions,
    asserted,
    unresolvedImports,
    helperAsserts,
    opaque,
    returned,
    progressOnly,
    observed,
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
  documentWrites: { chain: string; end: number }[] = [],
): { documentReads: number[]; mockRoots: (MockReference & { identifier: ts.Identifier })[] } {
  const seen = new Set<ts.Symbol>();
  const mockRoots: (MockReference & { identifier: ts.Identifier })[] = [];
  const documentReads: number[] = [];
  // `const onSave = props.onSave; expect(onSave)…` reads the mock of `props`.
  const addRoot = (expression: ts.Expression, below: string[], depth: number) => {
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
    mockRoots.push({ identifier: current, symbol, path: [...path, ...below] });
    const initializer = variableInitializer(symbol.valueDeclaration);

    if (initializer && depth < 5 && initializer.getSourceFile() === assertion.getSourceFile())
      addRoot(initializer, [...path, ...below], depth + 1);
  };
  const visit = (node: ts.Node, depth: number, position: number) => {
    for (const item of [node, ...descendants(node)]) {
      if ((ts.isCallExpression(item) && isDocumentQuery(item, checker)) || isDocumentRead(item, checker)) {
        const at = item !== node && inNestedFunction(item, node) ? assertion.getEnd() : position;
        const chain = documentChain(item as ts.Expression, checker, true);
        const written = documentWrites.some(
          (write) =>
            write.end < at &&
            chain !== undefined &&
            (chain === write.chain || chain.startsWith(`${write.chain}.`)),
        );

        if (!written) documentReads.push(at);
      }

      if (ts.isPropertyAccessExpression(item) && item.name.text === 'mock') addRoot(item.expression, [], 0);

      if (!ts.isIdentifier(item)) continue;
      const symbol = valueSymbol(item, checker);

      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      const initializer = variableInitializer(symbol.valueDeclaration);

      if (initializer && depth < 20 && initializer.getSourceFile() === node.getSourceFile())
        visit(initializer, depth + 1, initializer.getEnd());
    }
  };

  for (const value of comparedValues(assertion)) visit(value, 0, assertion.getEnd());
  const subject = assertion.arguments[0];

  if (subject && isExpectCall(assertion) && matcherNames(assertion).some((name) => MOCK_MATCHER.test(name)))
    addRoot(subject, [], 0);

  return { documentReads, mockRoots };
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

  if (!ts.isIdentifier(root) || root.text !== 'document' || root === top) return undefined;
  const declarations = checker.getSymbolAtLocation(root)?.declarations ?? [];

  if (!declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile)) return undefined;

  return top.getText().replace(/\s+/g, '');
}

/** What the global `document` exposes of the rendered page: `document.body`, `document.querySelector(...)`. */
const DOCUMENT_READS = new Set([
  'body',
  'documentElement',
  'activeElement',
  'querySelector',
  'querySelectorAll',
  'getElementById',
  'getElementsByClassName',
  'getElementsByTagName',
  'getElementsByName',
]);

/** A read of the page through the global `document` (not a local of that name), where Testing Library renders. */
function isDocumentRead(node: ts.Node, checker: ts.TypeChecker): boolean {
  if (!ts.isPropertyAccessExpression(node) || !DOCUMENT_READS.has(node.name.text)) return false;
  const receiver = skipParens(node.expression);

  if (!ts.isIdentifier(receiver) || receiver.text !== 'document') return false;
  const declarations = checker.getSymbolAtLocation(receiver)?.declarations ?? [];

  return declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile);
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

  if (ts.isIdentifier(callee)) return testingLibraryExport(callee, checker) === 'within';

  if (!ts.isPropertyAccessExpression(callee) || !DOCUMENT_QUERY.test(callee.name.text)) return false;
  const receiver = skipParens(callee.expression);

  return ts.isIdentifier(receiver) && testingLibraryExport(receiver, checker) === 'screen';
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
  const rendered = isJsxInvocation(node);

  if (rendered && !mountedJsx(node, ctx)) {
    ctx.callInfo.set(node, none);

    return none;
  }
  const passThrough = rendered && suppliesOnlyForeignChildren(node, ctx);

  if (direct)
    info = {
      ...none,
      targets: [
        { symbol: direct, ownArgs: true, assertedInside: false, flowsToResult: true, rendered, passThrough },
      ],
    };
  else {
    const helper = helperBody(node, ctx);
    const receiver = helper ? undefined : projectReceiver(node, ctx);

    if (helper) {
      info = helperInfo(helper, ctx);

      if (rendered) info = { ...info, targets: info.targets.map((target) => ({ ...target, rendered })) };
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

/** Functions that mount the element they are given: Testing Library, react-dom, react-test-renderer, Enzyme. */
const MOUNTING_FUNCTIONS = new Set([
  'render',
  'rerender',
  'hydrate',
  'hydrateRoot',
  'mount',
  'shallow',
  'create',
  'renderToString',
  'renderToStaticMarkup',
]);

/**
 * Whether a JSX element is mounted: it (or the JSX tree it sits in) is given to a function that mounts it, to a
 * function of the test code or the project (a render helper), or is returned by a function (a component or a helper,
 * judged where that is used), directly or through a local variable that is.
 */
function mountedJsx(node: ts.JsxSelfClosingElement | ts.JsxOpeningElement, ctx: Ctx): boolean {
  return mountedExpression(ts.isJsxOpeningElement(node) ? node.parent : node, ctx, 0);
}

function mountedExpression(expression: ts.Node, ctx: Ctx, depth: number): boolean {
  let current = expression;

  for (;;) {
    const parent = current.parent;

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
  const parent = current.parent;

  if (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === current)) return true;

  if (
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    parent.arguments?.includes(current as ts.Expression)
  ) {
    const callee = skipParens(parent.expression);
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : undefined;

    return (
      (name !== undefined && MOUNTING_FUNCTIONS.has(name)) ||
      helperBody(parent, ctx) !== undefined ||
      resolveProjectCall(parent, ctx.checker, ctx.projectSet, ctx.root) !== undefined
    );
  }

  // `const ui = <Dialog />; render(ui)`.
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === current &&
    ts.isIdentifier(parent.name) &&
    depth < 3
  ) {
    const symbol = ctx.checker.getSymbolAtLocation(parent.name);

    return (symbol ? referencesOf(symbol, parent.getSourceFile(), ctx.checker) : []).some(
      (item) => item !== parent.name && mountedExpression(item, ctx, depth + 1),
    );
  }

  return false;
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
  if (!ts.isJsxOpeningElement(node)) return false;
  const children = node.parent.children.filter(
    (child) => !(ts.isJsxText(child) && child.containsOnlyTriviaWhiteSpaces),
  );

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
    const assertedInside =
      target.assertedInside ||
      (target.flowsToResult && analysis.asserted.has(node)) ||
      analysis.observed.has(entry);
    const flowsToResult = target.flowsToResult && analysis.returned.has(node);
    // What a nested helper does with a mock it is given is decided inside it, where its own targets record it.
    const handed = helperBody(node, ctx) ? [] : (analysis.handed.get(node) ?? []);
    const previous = bySymbol.get(target.symbol);
    const observedBy = [...(previous?.observedBy ?? []), ...(target.observedBy ?? []), ...handed].filter(
      outside,
    );
    bySymbol.set(target.symbol, {
      symbol: target.symbol,
      ownArgs: false,
      assertedInside: assertedInside || previous?.assertedInside === true,
      flowsToResult: flowsToResult || previous?.flowsToResult === true,
      rendered: target.rendered === true || previous?.rendered === true,
      // Pass-through only if every rendering of it in the helper is.
      passThrough: target.passThrough === true && (previous === undefined || previous.passThrough === true),
      returnsMocks: returnedMocks.has(node) || previous?.returnsMocks === true,
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
 * Whether a file imports Vitest's assertions or its mock API as values (`import { expect } from 'vitest'`,
 * `import { vi } from 'vitest'`): that only runs inside a test run, so it is test code wherever it lives. Types and
 * a config helper (`vitest/config`) do not count.
 */
function importsVitestRuntime(source: ts.SourceFile): boolean {
  return source.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) return false;

    if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== 'vitest')
      return false;
    const bindings = statement.importClause?.namedBindings;

    // `import * as vitest from 'vitest'` brings in all of it.
    if (bindings && ts.isNamespaceImport(bindings)) return true;

    return (
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some(
        (element) => !element.isTypeOnly && VITEST_RUNTIME.has((element.propertyName ?? element.name).text),
      )
    );
  });
}

const VITEST_RUNTIME = new Set(['expect', 'assert', 'expectTypeOf', 'assertType', 'vi', 'vitest']);

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
 * Whether an expression creates a Vitest mock: `vi.fn(...)` or `vi.spyOn(...)`, possibly configured further
 * (`vi.fn().mockReturnValue(1)`).
 */
function isMockCreation(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  let current = skipParens(expression);

  while (ts.isCallExpression(current)) {
    const api = viCall(current, checker);

    if (api === 'fn' || api === 'spyOn') return true;

    if (!ts.isPropertyAccessExpression(current.expression)) return false;
    current = skipParens(current.expression.expression);
  }

  return false;
}

/**
 * The local variables an invocation is given that hold Vitest mocks: mocks themselves, named anywhere in its
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
  containers: { declaration: ts.VariableDeclaration; path: string[] }[];
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
  const containers = new Map<string, { declaration: ts.VariableDeclaration; path: string[] }>();
  const followed = new Set<string>();
  const ids = new Map<ts.Node, number>();
  const values = [...argumentsOf(call)];
  const follow = (node: ts.Node, key: string, expressions: ts.Expression[]) => {
    if (!ids.has(node)) ids.set(node, ids.size);
    const id = `${ids.get(node)}:${key}`;

    if (followed.has(id) || followed.size >= 20) return;
    followed.add(id);
    values.push(...expressions);
  };

  for (let index = 0; index < values.length; index++) {
    const argument = values[index] as ts.Expression;

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
      const holding =
        declaration && ts.isVariableDeclaration(declaration) ? mockHolding(declaration, checker) : undefined;

      if (holding === 'mock') mocks.add(declaration as ts.VariableDeclaration);

      if (holding === 'container' && declaration && ts.isVariableDeclaration(declaration)) {
        // `title={props.title}` hands over only `title`; `{...props}` or `props` hands over all of it.
        const path = memberPath(item);
        containers.set(`${ids.get(declaration) ?? declaration.pos}:${path.join('.')}`, { declaration, path });
        follow(declaration, path.join('.'), memberValues(valuesOf(declaration, checker), path));
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

  if (!ts.isCallExpression(call) || call.arguments[0] !== callback || !ts.isIdentifier(call.expression))
    return undefined;

  if (testingLibraryExport(call.expression, checker) !== 'renderHook') return undefined;
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

/** Whether a variable holds a Vitest mock (see `mockHolding`). */
function holdsMock(declaration: ts.VariableDeclaration, checker: ts.TypeChecker): boolean {
  return mockHolding(declaration, checker) === 'mock';
}

const mockHoldingCache = new WeakMap<ts.VariableDeclaration, 'mock' | 'container' | null>();
const deciding = new Set<ts.VariableDeclaration>();
let cycleSeen = false;

/**
 * What a variable holds: a Vitest mock (`const onSave = vi.fn()`, or a `let` only ever assigned mocks in a hook), an
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

/** Whether an expression makes a Vitest mock, or an object or array holding one (see `mockHolding`). */
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
      viCall(spy, checker) !== 'spyOn' &&
      ts.isPropertyAccessExpression(spy.expression)
    )
      spy = skipParens(spy.expression.expression);
    const watched =
      ts.isCallExpression(spy) && viCall(spy, checker) === 'spyOn' ? spy.arguments[0] : undefined;
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

    if (hook !== 'beforeEach' && hook !== 'beforeAll') return false;
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

/** `.each(table)`, `.for(table)`, `.skipIf(cond)` and `.runIf(cond)` return the function that registers. */
const REGISTRATION_FACTORIES = new Set(['each', 'for', 'skipIf', 'runIf']);
const TABLE_FACTORIES = new Set(['each', 'for']);

function testRegistration(node: ts.CallExpression): Registration | undefined {
  const direct = makesRegistration(node)
    ? undefined
    : (registration(node, 'it') ?? registration(node, 'test'));

  if (direct && Array.isArray(direct))
    return { name: literalString(node.arguments[0]), callback: callbackArgument(node), modifiers: direct };

  if (ts.isCallExpression(node.expression)) {
    const chain = propertyChain(node.expression.expression);
    const root = rootIdentifier(node.expression.expression);

    if (root && testNames.has(root) && chain.some((name) => REGISTRATION_FACTORIES.has(name))) {
      const eachModifiers = chain.filter((name): name is TestCaseType['modifiers'][number] =>
        modifiers.has(name),
      );

      if (chain.some((name) => TABLE_FACTORIES.has(name)) && !eachModifiers.includes('each'))
        eachModifiers.push('each');

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
  const direct = makesRegistration(node) ? undefined : registration(node, 'describe');

  if (direct && Array.isArray(direct)) {
    return { name: literalString(node.arguments[0]), callback: callbackArgument(node), modifiers: direct };
  }

  if (!ts.isCallExpression(node.expression)) return undefined;
  const chain = propertyChain(node.expression.expression);
  const root = rootIdentifier(node.expression.expression);

  if (!root || root !== 'describe' || !chain.some((name) => REGISTRATION_FACTORIES.has(name)))
    return undefined;
  const eachModifiers = chain.filter((name): name is TestCaseType['modifiers'][number] =>
    modifiers.has(name),
  );

  if (chain.some((name) => TABLE_FACTORIES.has(name)) && !eachModifiers.includes('each'))
    eachModifiers.push('each');

  return {
    name: literalString(node.arguments[0]),
    callback: callbackArgument(node),
    modifiers: eachModifiers,
  };
}

const vitestAliases = new WeakMap<ts.SourceFile, Map<string, string>>();

/** The Vitest export a local name stands for: itself, or the name imported as it (`import { it as vIt }`). */
function vitestName(identifier: ts.Identifier): string {
  const source = identifier.getSourceFile();
  let aliases = vitestAliases.get(source);

  if (!aliases) {
    aliases = new Map();

    for (const statement of source.statements) {
      const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined;

      if (
        !bindings ||
        !ts.isNamedImports(bindings) ||
        !ts.isStringLiteral((statement as ts.ImportDeclaration).moduleSpecifier) ||
        ((statement as ts.ImportDeclaration).moduleSpecifier as ts.StringLiteral).text !== 'vitest'
      )
        continue;

      for (const element of bindings.elements)
        if (element.propertyName) aliases.set(element.name.text, element.propertyName.text);
    }
    vitestAliases.set(source, aliases);
  }

  return aliases.get(identifier.text) ?? identifier.text;
}

function registration(
  node: ts.CallExpression,
  kind: 'it' | 'test' | 'describe',
): TestCaseType['modifiers'] | undefined {
  const chain: string[] = [];
  let expression: ts.Expression = node.expression;

  while (ts.isPropertyAccessExpression(expression)) {
    chain.push(expression.name.text);
    expression = expression.expression;
  }

  if (!ts.isIdentifier(expression) || vitestName(expression) !== kind) return undefined;
  const found = chain.filter((name): name is TestCaseType['modifiers'][number] => modifiers.has(name));

  return found;
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
    ? analyzeBody(body, ctx, (node) => isContextAssertion(node, contextParameter, checker))
    : undefined;
  const assertions = analysis?.assertions ?? [];
  const unresolvedImports = analysis?.unresolvedImports ?? new Set<string>();
  const calledSymbols = [...new Set(analysis?.calls.map((call) => call.target.symbol))];
  const relativeFile = toPosixRelative(root, file);
  const targetCalls = (analysis?.calls ?? []).map((entry) => {
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
        (target.flowsToResult && analysis?.asserted.has(node) === true) ||
        analysis?.observed.has(entry) === true,
      location: location(source, node, relativeFile),
    };
  });
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

  for (const [index, argument] of argumentsOf(node).entries())
    for (const value of given(argument)) {
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
    else if (MODULE_MOCK_APIS.has(viCall(node, checker) ?? '')) {
      const name = node.arguments[0];

      if (name && ts.isStringLiteralLike(name)) whole(resolveModule(name.text, source.fileName));
    }
  }

  return [...found].filter((file) => file !== source);
}

const MODULE_MOCK_APIS = new Set(['mock', 'doMock', 'unmock', 'doUnmock', 'importActual', 'importMock']);

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

/** A call to a real Vitest mock API, with the project symbols it replaces (if any). */
interface MockRecord {
  node: ts.CallExpression;
  /** `vi.mock` is hoisted by Vitest, so it applies to every test in the file wherever it is written. */
  fileWide: boolean;
  targets: string[];
}

const VI_MOCK_APIS = new Set(['mock', 'doMock', 'spyOn', 'fn', 'mocked', 'stubGlobal']);

/** `vi.<name>(...)` where `vi` is Vitest's (imported from 'vitest' or the ambient global). */
function viCall(node: ts.Expression, checker: ts.TypeChecker): string | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression;

  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return undefined;

  if (callee.expression.text !== 'vi') return undefined;
  const declarations = checker.getSymbolAtLocation(callee.expression)?.declarations ?? [];
  const fromVitest = declarations.every((declaration) => {
    if (!ts.isImportSpecifier(declaration)) return declaration.getSourceFile().isDeclarationFile;
    const specifier = declaration.parent.parent.parent.moduleSpecifier;

    return ts.isStringLiteral(specifier) && specifier.text === 'vitest';
  });

  return fromVitest ? callee.name.text : undefined;
}

function collectMocks(source: ts.SourceFile, ctx: Ctx): MockRecord[] {
  const { checker, projectSet, root } = ctx;
  const records: MockRecord[] = [];
  const spyTargets = (spy: ts.Expression): string[] => {
    const target = skipParens(spy);

    if (!ts.isCallExpression(target)) return [];
    const api = viCall(target, checker);

    if (api === 'mocked') {
      const argument = target.arguments[0];
      const id =
        argument && projectSymbolId(checker.getSymbolAtLocation(argument), checker, projectSet, root);

      return id ? [id] : [];
    }

    if (api !== 'spyOn') return [];
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
    const api = viCall(skipParens(declaration.initializer), checker);

    return api === 'spyOn' || api === 'mocked' || api === 'fn'
      ? spyTargets(declaration.initializer)
      : undefined;
  };

  for (const node of descendants(source)) {
    if (!ts.isCallExpression(node)) continue;
    const api = viCall(node, checker);

    if (api && VI_MOCK_APIS.has(api)) {
      const targets = api === 'mock' || api === 'doMock' ? moduleExports(node.arguments[0], ctx) : [];
      records.push({ node, fileWide: api === 'mock', targets });
      continue;
    }
    // `<spy>.mockReturnValue(...)` and friends, only on real Vitest spies.
    const callee = node.expression;

    if (!ts.isPropertyAccessExpression(callee) || !/^mock[A-Z]/.test(callee.name.text)) continue;
    const receiver = skipParens(callee.expression);
    const receiverApi = viCall(receiver, checker);

    if (receiverApi === 'spyOn' || receiverApi === 'mocked' || receiverApi === 'fn')
      records.push({ node, fileWide: false, targets: spyTargets(receiver) });
    else if (ts.isIdentifier(receiver)) {
      const targets = spyVariable(receiver);

      if (targets) records.push({ node, fileWide: false, targets });
    }
  }

  return records;
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

const HOOK_NAMES = new Set(['beforeEach', 'beforeAll', 'afterEach', 'afterAll']);

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
        (ts.isIdentifier(call.expression) && HOOK_NAMES.has(call.expression.text)));

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

/** Vitest's type-level checks, which compare types at compile time and do nothing when the test runs. */
function isTypeLevelAssertion(node: ts.CallExpression): boolean {
  const root = rootIdentifier(node.expression);

  return root === 'expectTypeOf' || root === 'assertType';
}

/** `expect(...)`, and Vitest's type-level checks `expectTypeOf(...)` and `assertType(...)`. */
function isExpectCall(node: ts.CallExpression): boolean {
  const root = rootIdentifier(node.expression);

  return root === 'expect' || root === 'expectTypeOf' || root === 'assertType';
}

function isAssertCall(node: ts.CallExpression): boolean {
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    (node.expression.expression.getText() === 'assert' || node.expression.name.text === 'assertions')
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
