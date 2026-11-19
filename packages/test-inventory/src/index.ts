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
} from '@veritas/core';
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
    visitTests(source, [], file, sourceFiles, projectSet, checker, root, tests);
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

function visitTests(
  source: ts.SourceFile,
  suitePath: string[],
  file: string,
  sourceFiles: Map<string, ts.SourceFile>,
  projectSet: Set<string>,
  checker: ts.TypeChecker,
  root: string,
  output: TestCaseType[],
): void {
  const walk = (node: ts.Node, currentSuite: string[]) => {
    if (ts.isCallExpression(node)) {
      const describe = registration(node, 'describe');
      if (describe) {
        const name = literalString(node.arguments[0]);
        const callback = node.arguments.at(-1);
        if (name !== undefined && callback && isFunction(callback)) {
          ts.forEachChild(callback, (child) => walk(child, [...currentSuite, name]));
          return;
        }
      }
      const info = testRegistration(node);
      if (info) {
        output.push(analyzeTest(node, info, currentSuite, file, sourceFiles, projectSet, checker, root));
        return;
      }
    }
    ts.forEachChild(node, (child) => walk(child, currentSuite));
  };
  walk(source, suitePath);
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

function registration(
  node: ts.CallExpression,
  kind: 'it' | 'test' | 'describe',
): TestCaseType['modifiers'] | true | undefined {
  const chain: string[] = [];
  let expression: ts.Expression = node.expression;
  while (ts.isPropertyAccessExpression(expression)) {
    chain.push(expression.name.text);
    expression = expression.expression;
  }
  if (!ts.isIdentifier(expression) || expression.text !== kind) return undefined;
  const found = chain.filter((name): name is TestCaseType['modifiers'][number] => modifiers.has(name));
  return kind === 'describe' ? true : found;
}

function analyzeTest(
  registrationCall: ts.CallExpression,
  info: Registration,
  suitePath: string[],
  file: string,
  _sourceFiles: Map<string, ts.SourceFile>,
  projectSet: Set<string>,
  checker: ts.TypeChecker,
  root: string,
): TestCaseType {
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
  const derivedAssertion = assertions.some((assertion) => {
    const argument = assertion.arguments[0];
    return Boolean(
      argument &&
        (calls.some((call) => contains(argument, call.node)) ||
          (ts.isIdentifier(argument) && localCalls.has(argument.text))),
    );
  });
  const usesMocks = descendants(source).some((node) => ts.isCallExpression(node) && isMockCall(node));
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
  if (assertions.length > 0 && !derivedAssertion) suspicions.push('tautological_assertion');
  if (calledSymbols.length === 0) suspicions.push('target_not_called');
  if (usesMocks && calledSymbols.length > 0) suspicions.push('unconditional_mock');
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
  let symbol = checker.getSymbolAtLocation(node.expression);
  if (!symbol) return undefined;
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol.declarations?.find((item) =>
    projectSet.has(path.resolve(item.getSourceFile().fileName)),
  );
  if (!declaration) return undefined;
  return symbolId(toPosixRelative(root, declaration.getSourceFile().fileName), symbol.getName());
}

function isMockCall(node: ts.CallExpression): boolean {
  return /^vi\.(mock|spyOn)\b/.test(node.getText()) || node.getText().includes('.mockReturnValue(');
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
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      names.has(node.name.text) &&
      descendants(node).some(
        (child) => ts.isCallExpression(child) && (isExpectCall(child) || isAssertCall(child)),
      )
    )
      found = true;
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
  return { file, range: { start: node.getStart(source) + 1, end: node.getEnd() } };
}
function literalArgument(node: ts.Expression): string | null {
  return ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
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
