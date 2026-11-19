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
  files: z.array(z.object({ path: z.string(), hash: z.string() })),
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
  ).filter((file) => !uniqueFiles.includes(path.resolve(file)));
  const compilerOptions = readCompilerOptions(root, options.config);
  const program = ts.createProgram([...projectFiles, ...uniqueFiles], compilerOptions);
  const checker = program.getTypeChecker();
  const sourceFiles = new Map<string, ts.SourceFile>();
  for (const sourceFile of program.getSourceFiles())
    sourceFiles.set(path.resolve(sourceFile.fileName), sourceFile);
  const projectSet = new Set(projectFiles.map((file) => path.resolve(file)));
  const tests: TestCaseType[] = [];
  const diagnostics: { file: string; message: string }[] = [];

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
    const ctx: Ctx = { checker, projectSet, root, program, compilerOptions, file };
    const mocks = collectMocks(source, ctx);
    visitTests(source, [], [], file, mocks, ctx, tests);
  }

  const edges: TestPropertyEdgeType[] = [];
  for (const test of tests) {
    for (const symbol of test.calledSymbols) {
      const evidence: TestPropertyEdgeType['evidence'] = [
        { kind: 'static_call', detail: 'Project symbol called from test body', artifactIds: [] },
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

  const files = uniqueFiles.map((file) => ({
    path: toPosixRelative(root, file),
    hash: sha256(readFileSync(file)),
  }));
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
        const callback = node.arguments.at(-1);
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

function testRegistration(node: ts.CallExpression): Registration | undefined {
  const direct = registration(node, 'it') ?? registration(node, 'test');
  if (direct && Array.isArray(direct))
    return { name: literalString(node.arguments[0]), callback: node.arguments.at(-1), modifiers: direct };
  if (ts.isCallExpression(node.expression)) {
    const chain = propertyChain(node.expression.expression);
    const root = rootIdentifier(node.expression.expression);
    if (root && testNames.has(root) && chain.includes('each')) {
      const eachModifiers = chain.filter((name): name is TestCaseType['modifiers'][number] =>
        modifiers.has(name),
      );
      if (!eachModifiers.includes('each')) eachModifiers.push('each');
      return {
        name: literalString(node.arguments[0]),
        callback: node.arguments.at(-1),
        modifiers: eachModifiers,
      };
    }
  }
  return undefined;
}

function describeRegistration(node: ts.CallExpression): Registration | undefined {
  const direct = registration(node, 'describe');
  if (direct && Array.isArray(direct)) {
    return { name: literalString(node.arguments[0]), callback: node.arguments.at(-1), modifiers: direct };
  }
  if (!ts.isCallExpression(node.expression)) return undefined;
  const chain = propertyChain(node.expression.expression);
  const root = rootIdentifier(node.expression.expression);
  if (!root || root !== 'describe' || !chain.includes('each')) return undefined;
  const eachModifiers = chain.filter((name): name is TestCaseType['modifiers'][number] =>
    modifiers.has(name),
  );
  if (!eachModifiers.includes('each')) eachModifiers.push('each');
  return {
    name: literalString(node.arguments[0]),
    callback: node.arguments.at(-1),
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
  const { checker, projectSet, root } = ctx;
  const source = registrationCall.getSourceFile();
  const callback = info.callback;
  const name = info.name ?? '<dynamic test>';
  const body = callback && isFunction(callback) ? callback.body : undefined;
  const calls: { node: ts.CallExpression; symbol: string }[] = [];
  const assertions: ts.CallExpression[] = [];
  const localCalls = new Map<string, { node: ts.CallExpression; symbol: string }>();
  const nodes = body ? descendants(body) : [];
  for (const node of nodes) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const resolved = resolveProjectCall(node.initializer, checker, projectSet, root);
      if (resolved) localCalls.set(node.name.text, { node: node.initializer, symbol: resolved });
    }
    if (!ts.isCallExpression(node)) continue;
    const resolved = resolveProjectCall(node, checker, projectSet, root);
    if (resolved) calls.push({ node, symbol: resolved });
    if (isExpectCall(node) || isAssertCall(node)) assertions.push(node);
  }
  const calledSymbols = [...new Set(calls.map((call) => call.symbol))];
  const asserted = new Set<number>();
  for (const assertion of assertions) {
    const argument = assertion.arguments[0];
    if (!argument) continue;
    for (const call of calls) if (contains(argument, call.node)) asserted.add(call.node.getStart(source));
    if (ts.isIdentifier(argument)) {
      const call = localCalls.get(argument.text);
      if (call) asserted.add(call.node.getStart(source));
    }
  }
  const relativeFile = toPosixRelative(root, file);
  const targetCalls = calls.map(({ node, symbol }) => ({
    symbol,
    args: node.arguments.map(literalArgument),
    asserted: asserted.has(node.getStart(source)),
    location: location(source, node, relativeFile),
  }));
  // Tautological only when every compared value (subject and expected) is a compile-time
  // constant; runtime values such as process.env or non-project call results are not.
  const comparisons = assertions.filter((assertion) => !isAssertionCountCall(assertion));
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
  if (assertions.length === 0 && !callsHelperWithAssertion(body, source)) suspicions.push('no_assertion');
  if (tautological) suspicions.push('tautological_assertion');
  if (calledSymbols.length === 0) suspicions.push('target_not_called');
  if (mockedTarget) suspicions.push('unconditional_mock');
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
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  projectSet: Set<string>,
  root: string,
): string | undefined {
  return projectSymbolId(checker.getSymbolAtLocation(node.expression), checker, projectSet, root);
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
        isCompileTimeConstant(declaration.initializer, checker, depth + 1),
    );
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

function isExpectCall(node: ts.CallExpression): boolean {
  return rootIdentifier(node.expression) === 'expect';
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
function literalArgument(input: ts.Expression): string | null {
  const node = skipParens(input);
  if (ts.isNumericLiteral(node)) return node.text;
  if (ts.isBigIntLiteral(node)) return node.text;
  if (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken)
  ) {
    const operand = skipParens(node.operand);
    if (!ts.isNumericLiteral(operand) && !ts.isBigIntLiteral(operand)) return null;
    return node.operator === ts.SyntaxKind.MinusToken ? `-${operand.text}` : operand.text;
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
      else if (isSourceFile(file)) {
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
function readCompilerOptions(root: string, config: VeritasConfig): ts.CompilerOptions {
  const configFile = config.project.tsconfig
    ? path.resolve(root, config.project.tsconfig)
    : ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
  if (!configFile)
    return {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2024,
      allowJs: true,
    };
  const parsed = ts.readConfigFile(configFile, ts.sys.readFile);
  if (parsed.error)
    return {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2024,
      allowJs: true,
    };
  return ts.parseJsonConfigFileContent(parsed.config, ts.sys, path.dirname(configFile)).options;
}
