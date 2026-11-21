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
  // Assertion helpers kept with the source (`src/vitest/expectIssue.ts`) are test code: they stay in the program
  // so their imports resolve, but calls into them are followed as helpers, not counted as project targets.
  const projectSet = new Set(
    projectFiles
      .map((file) => path.resolve(file))
      .filter((file) => {
        const source = sourceFiles.get(file);

        return !source || !importsVitestAssertions(source);
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

  const files = uniqueFiles.map((file) => {
    const source = sourceFiles.get(file);
    const dependencies = source ? localDependencies(source, checker, root) : [];
    const reached = [
      source,
      ...dependencies.map((dependency) => sourceFiles.get(path.resolve(root, dependency))),
    ];

    return {
      path: toPosixRelative(root, file),
      hash: sha256(readFileSync(file)),
      dependencies,
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

/** Code that runs a function: a call, a constructor call (`new X()`) or a tagged template (`` tag`...` ``). */
type Invocation = ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression;

function isInvocation(node: ts.Node): node is Invocation {
  return ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node);
}

function calleeOf(node: Invocation): ts.Expression {
  return ts.isTaggedTemplateExpression(node) ? node.tag : node.expression;
}

/** The values an invocation passes: its arguments, or the substitutions of a tagged template. */
function argumentsOf(node: Invocation): readonly ts.Expression[] {
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
}

interface CallInfo {
  targets: Target[];
  /** The call runs a helper that contains an assertion. */
  helperAsserts: boolean;
  /** The call runs code static analysis cannot follow: a child process or a dynamic import. */
  opaque: boolean;
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
}

/**
 * Calls, assertions and result flow in a test body or helper body. Values are followed through local and
 * enclosing (describe-level or module-level) variables of the same file, including `let` set in a hook.
 */
function analyzeBody(body: ts.Node, ctx: Ctx): BodyAnalysis {
  const { checker } = ctx;
  const source = body.getSourceFile();
  const calls: BodyAnalysis['calls'] = [];
  const recorded = new Set<Invocation>();
  const assertions: ts.CallExpression[] = [];
  const unresolvedImports = new Set<string>();
  let helperAsserts = false;
  let opaque = false;
  const record = (node: Invocation): boolean => {
    const info = callInfo(node, ctx);

    if (!recorded.has(node)) {
      recorded.add(node);

      for (const target of info.targets) calls.push({ node, target });
      helperAsserts ||= info.helperAsserts;
      opaque ||= info.opaque;
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
      declaration.initializer &&
      isMockCreation(declaration.initializer, checker)
    )
      sources = descendants(source).filter(
        (node): node is Invocation =>
          isInvocation(node) &&
          !contains(body, node) &&
          runsBefore(node, body) &&
          mocksPassed(node, checker).includes(declaration) &&
          record(node),
      );

    if (sources.length > 0) localCalls.set(symbol, sources);
  };
  const trackedCalls = (expression: ts.Node): Invocation[] => {
    const found = new Set<Invocation>();

    for (const item of [expression, ...descendants(expression)]) {
      if (!ts.isIdentifier(item)) continue;
      const symbol = checker.getSymbolAtLocation(item);

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
    for (const declaration of mocksPassed(call, checker))
      if (declaration.getSourceFile() === source) bind(bindingIdentifiers(declaration.name), [call], true);

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

    if (!isInvocation(node)) continue;

    if (record(node)) bindCallOutputs(node);
    else {
      const specifier = unresolvedImportOf(calleeOf(node), ctx);

      if (specifier !== undefined) unresolvedImports.add(specifier);
    }

    if (ts.isCallExpression(node) && (isExpectCall(node) || isAssertCall(node))) assertions.push(node);
  }
  // What a helper returns may come from enclosing variables, e.g. `const of = (n) => candidates.filter(...)`.
  const returned = new Set(
    sourcesOf(ts.isBlock(body) ? returnedExpressions(body) : ts.isExpression(body) ? [body] : []),
  );
  const asserted = new Set<Invocation>();

  // Either side of a comparison counts: `expect(['a', 'b']).toContain(result.status)` checks the result.
  for (const value of assertions.flatMap(comparedValues)) {
    for (const call of trackedCalls(value)) asserted.add(call);

    for (const { node } of calls) if (contains(value, node)) asserted.add(node);
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
  const awaitedProject = awaited.filter((node) => sourcesOf([node.expression]).length > 0);
  const checks = assertions.filter(
    (assertion) => !isAssertionCountCall(assertion) && !isTypeLevelAssertion(assertion),
  );
  const progressOnly =
    asserted.size === 0 &&
    awaitedProject.length > 0 &&
    checks.length > 0 &&
    recordsProgress(checks, body, Math.min(...awaitedProject.map((node) => node.getEnd())), checker);

  return { calls, assertions, asserted, unresolvedImports, helperAsserts, opaque, returned, progressOnly };
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

  if (direct)
    info = {
      ...none,
      targets: [{ symbol: direct, ownArgs: true, assertedInside: false, flowsToResult: true }],
    };
  else {
    const helper = helperBody(node, ctx);
    const receiver = helper ? undefined : projectReceiver(node, ctx);

    if (helper) info = helperInfo(helper, ctx);
    else if (receiver)
      info = {
        ...none,
        targets: [{ symbol: receiver, ownArgs: false, assertedInside: false, flowsToResult: true }],
      };
    else
      info = {
        ...none,
        opaque: !ts.isTaggedTemplateExpression(node) && isOpaqueCall(node, ctx.checker),
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

  for (const { node, target } of analysis.calls) {
    const assertedInside = target.assertedInside || (target.flowsToResult && analysis.asserted.has(node));
    const flowsToResult = target.flowsToResult && analysis.returned.has(node);
    const previous = bySymbol.get(target.symbol);
    bySymbol.set(target.symbol, {
      symbol: target.symbol,
      ownArgs: false,
      assertedInside: assertedInside || previous?.assertedInside === true,
      flowsToResult: flowsToResult || previous?.flowsToResult === true,
    });
  }
  const info: CallInfo = {
    targets: [...bySymbol.values()],
    helperAsserts: analysis.assertions.length > 0 || analysis.helperAsserts,
    opaque: analysis.opaque,
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
 * Whether a file imports Vitest's assertions as values (`import { expect } from 'vitest'`): it asserts, so it is
 * test code wherever it lives. Importing anything else from Vitest (a config helper, `vi`) does not count.
 */
function importsVitestAssertions(source: ts.SourceFile): boolean {
  return source.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) return false;

    if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== 'vitest')
      return false;
    const bindings = statement.importClause?.namedBindings;

    return (
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some(
        (element) =>
          !element.isTypeOnly && VITEST_ASSERTIONS.has((element.propertyName ?? element.name).text),
      )
    );
  });
}

const VITEST_ASSERTIONS = new Set(['expect', 'assert', 'expectTypeOf', 'assertType']);

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

/** The local variables holding a Vitest mock that are named anywhere in an invocation's arguments. */
function mocksPassed(call: Invocation, checker: ts.TypeChecker): ts.VariableDeclaration[] {
  const found = new Set<ts.VariableDeclaration>();

  for (const argument of argumentsOf(call))
    for (const item of [argument, ...descendants(argument)]) {
      if (!ts.isIdentifier(item)) continue;
      // In `{ cloneObject }` the name is the property; the variable is its value.
      const symbol =
        ts.isShorthandPropertyAssignment(item.parent) && item.parent.name === item
          ? checker.getShorthandAssignmentValueSymbol(item.parent)
          : checker.getSymbolAtLocation(item);
      const declaration = symbol?.valueDeclaration;

      if (
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        isMockCreation(declaration.initializer, checker)
      )
        found.add(declaration);
    }

  return [...found];
}

/**
 * Whether code outside a test body runs before it as shared setup: at module or describe level, or in a
 * `beforeEach`/`beforeAll` hook, of describes that enclose the body. Code in another test, in an unrelated
 * describe or in a function that is only defined there does not.
 */
function runsBefore(node: ts.Node, body: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (!isFunctionLike(current)) continue;
    const call = current.parent;

    if (!call || !ts.isCallExpression(call)) return false;
    const suite = describeRegistration(call);

    if (suite?.callback === current) {
      if (!contains(current, body)) return false;
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
  return descendants(source)
    .filter(
      (node): node is ts.BinaryExpression =>
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        checker.getSymbolAtLocation(node.left) === symbol,
    )
    .map((node) => node.right);
}

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

  if (!ts.isIdentifier(expression) || expression.text !== kind) return undefined;
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
  const analysis = body ? analyzeBody(body, ctx) : undefined;
  const assertions = analysis?.assertions ?? [];
  const unresolvedImports = analysis?.unresolvedImports ?? new Set<string>();
  const calledSymbols = [...new Set(analysis?.calls.map((call) => call.target.symbol))];
  const relativeFile = toPosixRelative(root, file);
  const targetCalls = (analysis?.calls ?? []).map(({ node, target }) => ({
    symbol: target.symbol,
    // A helper's or a method's arguments are not the project function's, so they say nothing about its inputs.
    args:
      target.ownArgs && !ts.isTaggedTemplateExpression(node) ? argumentsOf(node).map(literalArgument) : [],
    asserted: target.assertedInside || (target.flowsToResult && analysis?.asserted.has(node) === true),
    location: location(source, node, relativeFile),
  }));
  // Tautological only when every compared value (subject and expected) is a compile-time
  // constant; runtime values such as process.env or non-project call results are not.
  const typeLevel = assertions.length > 0 && assertions.every(isTypeLevelAssertion);
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

  if (assertions.length === 0 && !analysis?.helperAsserts && !callsHelperWithAssertion(body, source))
    suspicions.push('no_assertion');

  if (tautological) suspicions.push('tautological_assertion');
  // Code that runs when the file loads (outside any function), its own or that of the local modules it imports,
  // runs before every test in it.
  const loading = fileLoadReach(source, ctx);
  const opaque = analysis?.opaque === true || loading.opaque;
  const unresolved = unresolvedImports.size > 0 || loading.unresolved;

  // An unresolved import, a child process or a dynamic import may well reach project code: absence is not proven.
  if (typeLevel) suspicions.push('type_level_only');
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
  const seen = new Set<ts.SourceFile>([start]);
  const queue = [start];

  for (let source = queue.shift(); source; source = queue.shift()) {
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

      if (!target || !ts.isSourceFile(target) || target.isDeclarationFile || seen.has(target)) continue;
      const relative = path.relative(root, path.resolve(target.fileName));

      if (
        relative.startsWith('..') ||
        path.isAbsolute(relative) ||
        relative.split(path.sep).includes('node_modules')
      )
        continue;
      seen.add(target);
      queue.push(target);
    }
  }

  return [...seen]
    .filter((source) => source !== start)
    .map((source) => toPosixRelative(root, source.fileName))
    .sort();
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
