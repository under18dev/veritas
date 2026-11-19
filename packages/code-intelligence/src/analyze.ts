import { realpathSync } from 'node:fs';
import path from 'node:path';
import { type Location, sha256, symbolId, type VeritasConfig } from '@veritas/core';
import ts from 'typescript';
import { type SelectedFile, selectFiles } from './files.js';
import type { CodeIndex, Comparison, ComparisonOperator, FunctionInfo, NumericKind } from './schema.js';

export interface AnalyzeOptions {
  root: string;
  config: VeritasConfig;
  /** POSIX paths relative to `root`. Defaults to `analysis.include` minus `exclude` minus test files. */
  files?: string[];
}

type FunctionNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

interface Indexed {
  node: FunctionNode;
  info: FunctionInfo;
  /** Reasons purity cannot be decided locally (unresolved callees, dynamic code). */
  unknown: string[];
  /** Symbol ids of indexed callees, for purity propagation. */
  internalCalls: string[];
}

const DEFAULT_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2024,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  allowJs: true,
  checkJs: false,
  skipLibCheck: true,
  types: [],
};

const NUMERIC_KIND_ORDER: NumericKind[] = ['integer_literal', 'float_literal', 'division', 'nan', 'bigint'];

const COMPARISON_OPERATORS = new Map<ts.SyntaxKind, ComparisonOperator>([
  [ts.SyntaxKind.LessThanToken, '<'],
  [ts.SyntaxKind.LessThanEqualsToken, '<='],
  [ts.SyntaxKind.GreaterThanToken, '>'],
  [ts.SyntaxKind.GreaterThanEqualsToken, '>='],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, '==='],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, '!=='],
  [ts.SyntaxKind.EqualsEqualsToken, '=='],
  [ts.SyntaxKind.ExclamationEqualsToken, '!='],
]);

const ARITHMETIC_OPERATORS = new Set([
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
]);

/** Globals whose use is a side effect (I/O, ambient state, scheduling, non-determinism). */
const IMPURE_GLOBALS = new Set([
  'console',
  'process',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'document',
  'window',
  'navigator',
  'location',
  'globalThis',
  'global',
  'self',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'clearTimeout',
  'clearInterval',
  'clearImmediate',
  'queueMicrotask',
  'requestAnimationFrame',
  'require',
  'alert',
  'prompt',
  'confirm',
  'performance',
  'crypto',
  'Deno',
  'Bun',
]);

/** Modules whose imports perform I/O or touch the host. */
const IO_MODULES = new Set([
  'fs',
  'fs/promises',
  'child_process',
  'http',
  'https',
  'http2',
  'net',
  'tls',
  'dgram',
  'dns',
  'dns/promises',
  'os',
  'process',
  'readline',
  'worker_threads',
  'cluster',
  'crypto',
  'vm',
  'module',
  'v8',
  'inspector',
  'perf_hooks',
  'timers',
  'timers/promises',
  'stream',
  'stream/promises',
  'sqlite',
]);

const MUTATING_METHODS = new Set([
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
  'fill',
  'copyWithin',
  'set',
  'add',
  'delete',
  'clear',
]);

/**
 * Statically index functions with the TypeScript Compiler API. Project code is parsed and
 * type-checked, never executed.
 */
export function analyzeCode(options: AnalyzeOptions): CodeIndex {
  const root = realpathSync(options.root);
  const selection = selectFiles(root, options.config, options.files);
  const diagnostics = [...selection.diagnostics];
  const compilerOptions = loadCompilerOptions(root, options.config, diagnostics);
  const program = createProgram(selection.files, compilerOptions);
  const checker = program.getTypeChecker();
  const ctx = new Context(root, program, checker, selection.files);

  const indexed: Indexed[] = [];
  for (const file of selection.files) {
    const sf = program.getSourceFile(file.absolute);
    if (!sf) {
      diagnostics.push({ file: file.path, message: 'skipped: the compiler did not load this file' });
      continue;
    }
    for (const d of program.getSyntacticDiagnostics(sf)) {
      const line = d.start === undefined ? null : sf.getLineAndCharacterOfPosition(d.start).line + 1;
      const text = ts.flattenDiagnosticMessageText(d.messageText, ' ');
      diagnostics.push({ file: file.path, message: line === null ? text : `line ${line}: ${text}` });
    }
    for (const target of collectFunctions(sf, diagnostics, file.path)) {
      indexed.push(analyzeFunction(target, sf, file.path, ctx));
    }
  }

  dedupeSymbols(indexed, diagnostics);
  propagatePurity(indexed);

  return {
    files: selection.files.map((f) => ({ path: f.path, hash: sha256(f.content) })),
    functions: indexed.map((i) => i.info),
    diagnostics,
  };
}

function loadCompilerOptions(
  root: string,
  config: VeritasConfig,
  diagnostics: CodeIndex['diagnostics'],
): ts.CompilerOptions {
  const tsconfig = config.project.tsconfig;
  if (!tsconfig) return DEFAULT_OPTIONS;
  const file = path.resolve(root, tsconfig);
  const rel = path.relative(root, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    diagnostics.push({
      file: tsconfig,
      message: 'tsconfig outside the project root ignored; using defaults',
    });
    return DEFAULT_OPTIONS;
  }
  const read = ts.readConfigFile(file, ts.sys.readFile);
  if (read.error) {
    const text = ts.flattenDiagnosticMessageText(read.error.messageText, ' ');
    diagnostics.push({ file: tsconfig, message: `tsconfig not usable, using defaults: ${text}` });
    return DEFAULT_OPTIONS;
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(file), undefined, file);
  for (const error of parsed.errors) {
    if (error.code === 18003) continue; // "no inputs found": we supply our own root files
    diagnostics.push({ file: tsconfig, message: ts.flattenDiagnosticMessageText(error.messageText, ' ') });
  }
  return { ...parsed.options, allowJs: true, noEmit: true, types: parsed.options.types ?? [] };
}

function createProgram(files: SelectedFile[], options: ts.CompilerOptions): ts.Program {
  const host = ts.createCompilerHost({ ...options, noEmit: true });
  // Analyze exactly the bytes that were hashed.
  const contents = new Map(files.map((f) => [path.normalize(f.absolute), f.content]));
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (name) => contents.get(path.normalize(name)) ?? readFile(name);
  host.fileExists = (name) => contents.has(path.normalize(name)) || fileExists(name);
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) => {
    const content = contents.get(path.normalize(name));
    if (content !== undefined) return ts.createSourceFile(name, content, languageVersion, true);
    return getSourceFile(name, languageVersion, onError, shouldCreate);
  };
  return ts.createProgram({
    rootNames: files.map((f) => f.absolute),
    options: { ...options, noEmit: true },
    host,
  });
}

class Context {
  /** Declaration node -> exported name, per source file. */
  private readonly exportNames = new Map<ts.Node, string[]>();
  private readonly loadedExports = new Set<ts.SourceFile>();

  constructor(
    readonly root: string,
    readonly program: ts.Program,
    readonly checker: ts.TypeChecker,
    readonly selected: SelectedFile[],
  ) {}

  /** Project-relative POSIX path for files inside the root, null for libraries and outside files. */
  projectPath(sf: ts.SourceFile): string | null {
    if (sf.isDeclarationFile || this.program.isSourceFileDefaultLibrary(sf)) return null;
    if (this.program.isSourceFileFromExternalLibrary(sf)) return null;
    const rel = path.relative(this.root, sf.fileName);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const posix = rel.split(path.sep).join('/');
    return posix.split('/').includes('node_modules') ? null : posix;
  }

  exportedNames(node: ts.Node): string[] {
    const sf = node.getSourceFile();
    if (!this.loadedExports.has(sf)) {
      this.loadedExports.add(sf);
      const moduleSymbol = this.checker.getSymbolAtLocation(sf);
      for (const exported of moduleSymbol ? this.checker.getExportsOfModule(moduleSymbol) : []) {
        const target =
          exported.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(exported) : exported;
        for (const decl of target.declarations ?? []) {
          const names = this.exportNames.get(decl) ?? [];
          names.push(exported.name);
          this.exportNames.set(decl, names);
        }
      }
    }
    return [...(this.exportNames.get(node) ?? [])].sort();
  }

  /** The symbol name used in ids: the exported name when exported (preferring the local one). */
  publicName(declaration: ts.Node, local: string): { name: string; exported: boolean } {
    const names = this.exportedNames(declaration);
    if (names.length === 0) return { name: local, exported: false };
    return { name: names.includes(local) ? local : (names[0] as string), exported: true };
  }

  resolve(node: ts.Node): ts.Symbol | undefined {
    const symbol = this.checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      try {
        return this.checker.getAliasedSymbol(symbol);
      } catch {
        return undefined;
      }
    }
    return symbol;
  }

  /** True when the identifier refers to an ambient global rather than a project declaration. */
  isGlobal(identifier: ts.Identifier): boolean {
    const symbol = this.checker.getSymbolAtLocation(identifier);
    if (!symbol?.declarations?.length) return true;
    return symbol.declarations.every((d) => this.projectPath(d.getSourceFile()) === null && !isImport(d));
  }
}

interface FunctionTarget {
  node: FunctionNode;
  /** Declaration used for export lookup (function, variable or class). */
  declaration: ts.Node;
  local: string;
  memberOf?: { declaration: ts.ClassLikeDeclaration; local: string };
  accessor?: 'get' | 'set';
}

function collectFunctions(
  sf: ts.SourceFile,
  diagnostics: CodeIndex['diagnostics'],
  file: string,
): FunctionTarget[] {
  const out: FunctionTarget[] = [];
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.body) {
      out.push({ node: statement, declaration: statement, local: statement.name?.text ?? 'default' });
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        const init = decl.initializer && skipParens(decl.initializer);
        if (
          ts.isIdentifier(decl.name) &&
          init &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        ) {
          out.push({ node: init, declaration: decl, local: decl.name.text });
        }
      }
    } else if (ts.isClassDeclaration(statement)) {
      const className = statement.name?.text ?? 'default';
      for (const member of statement.members) {
        const isAccessor = ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member);
        if (!(ts.isMethodDeclaration(member) || isAccessor) || !member.body) continue;
        if (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name)) {
          diagnostics.push({
            file,
            message: `line ${lineOf(sf, member)}: skipped class member with a computed or private name in ${className}`,
          });
          continue;
        }
        out.push({
          node: member,
          declaration: member,
          local: member.name.text,
          memberOf: { declaration: statement, local: className },
          ...(ts.isGetAccessorDeclaration(member) ? { accessor: 'get' as const } : {}),
          ...(ts.isSetAccessorDeclaration(member) ? { accessor: 'set' as const } : {}),
        });
      }
    } else if (ts.isExportAssignment(statement)) {
      const expr = skipParens(statement.expression);
      if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
        out.push({ node: expr, declaration: statement, local: 'default' });
      }
    }
  }
  return out;
}

function symbolNameOf(ctx: Context, target: FunctionTarget): { name: string; exported: boolean } {
  if (target.memberOf) {
    const owner = ctx.publicName(target.memberOf.declaration, target.memberOf.local);
    const suffix = target.accessor === 'set' ? '=' : '';
    return { name: `${owner.name}.${target.local}${suffix}`, exported: owner.exported };
  }
  if (ts.isExportAssignment(target.declaration)) return { name: 'default', exported: true };
  return ctx.publicName(target.declaration, target.local);
}

/** Symbol id for a callee declaration inside the project, mirroring how functions are indexed. */
function calleeSymbol(ctx: Context, decl: ts.Declaration): string | null {
  const file = ctx.projectPath(decl.getSourceFile());
  if (file === null) return null;
  if (ts.isFunctionDeclaration(decl))
    return symbolId(file, decl.name ? ctx.publicName(decl, decl.name.text).name : 'default');
  if (ts.isExportAssignment(decl)) {
    const expr = skipParens(decl.expression);
    return ts.isArrowFunction(expr) || ts.isFunctionExpression(expr) ? symbolId(file, 'default') : null;
  }
  if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
    return symbolId(file, ctx.publicName(decl, decl.name.text).name);
  }
  if (ts.isMethodDeclaration(decl) && (ts.isIdentifier(decl.name) || ts.isStringLiteral(decl.name))) {
    const owner = decl.parent;
    if (ts.isClassDeclaration(owner)) {
      const className = owner.name?.text ?? 'default';
      return symbolId(file, `${ctx.publicName(owner, className).name}.${decl.name.text}`);
    }
  }
  return null;
}

function analyzeFunction(target: FunctionTarget, sf: ts.SourceFile, file: string, ctx: Context): Indexed {
  const { node } = target;
  const { checker } = ctx;
  const { name: publicName, exported } = symbolNameOf(ctx, target);
  const fnName = target.memberOf ? `${target.memberOf.local}.${target.local}` : target.local;

  const info: FunctionInfo = {
    symbol: symbolId(file, publicName),
    name: fnName,
    file,
    exported,
    location: loc(sf, file, target.declaration === node ? node : outerStatement(target.declaration)),
    params: node.parameters.map((p) => ({
      name: p.name.getText(sf),
      type: checker.typeToString(checker.getTypeAtLocation(p), node, ts.TypeFormatFlags.NoTruncation),
      optional: Boolean(p.questionToken || p.initializer),
    })),
    returnType: returnTypeOf(checker, node),
    jsdoc: jsdocOf(sf, target),
    async: hasModifier(node, ts.SyntaxKind.AsyncKeyword),
    branches: [],
    comparisons: [],
    returns: [],
    throws: [],
    calls: [],
    sideEffects: [],
    unsupported: [],
    purity: 'pure',
    numericKinds: [],
  };
  const result: Indexed = { node, info, unknown: [], internalCalls: [] };
  const numeric = new Set<NumericKind>();
  const unsupportedSeen = new Set<string>();
  const unsupported = (at: ts.Node, reason: string) => {
    const location = loc(sf, file, at);
    const key = `${location.range?.start}:${reason}`;
    if (unsupportedSeen.has(key)) return;
    unsupportedSeen.add(key);
    info.unsupported.push({ location, reason });
  };
  const sideEffect = (effect: string) => {
    if (!info.sideEffects.includes(effect)) info.sideEffects.push(effect);
  };
  const call = (entry: string) => {
    if (!info.calls.includes(entry)) info.calls.push(entry);
  };
  const text = (n: ts.Node) => n.getText(sf).replace(/\s+/g, ' ');

  /**
   * Unsupported constructs that change control flow or evaluation semantics (async, generators,
   * accessors, `this`, dynamic code...) make purity undecidable here, so they also mark the
   * function `unknown`. Purely numeric notes (float literals, division, NaN, bigint, coercion,
   * `Math.*`) stay listed in `unsupported`/`numericKinds` but do not affect purity: they are
   * deterministic and side-effect free; they only fall outside the integer model.
   */
  const undecidable = (at: ts.Node, reason: string) => {
    unsupported(at, reason);
    result.unknown.push(reason);
  };
  if (info.async) undecidable(node, 'async function');
  if (
    (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) &&
    node.asteriskToken
  ) {
    undecidable(node, 'generator function');
  }
  if (target.accessor) undecidable(node, `${target.accessor === 'get' ? 'getter' : 'setter'} accessor`);

  const isOwnParam = (expr: ts.Expression): string | null => {
    const e = skipParens(expr);
    if (!ts.isIdentifier(e)) return null;
    const symbol = checker.getSymbolAtLocation(e);
    const decl = symbol?.valueDeclaration;
    return decl && ts.isParameter(decl) && decl.parent === node && ts.isIdentifier(decl.name)
      ? decl.name.text
      : null;
  };
  const isLocal = (decl: ts.Declaration) =>
    decl.getSourceFile() === sf && decl.pos >= node.pos && decl.end <= node.end;

  /** Record writes: outer variables and parameter properties make the function impure. */
  const recordWrite = (targetExpr: ts.Expression, mutatesValue = false) => {
    const t = skipParens(targetExpr);
    if (ts.isArrayLiteralExpression(t)) {
      for (const el of t.elements) recordWrite(ts.isSpreadElement(el) ? el.expression : el);
      return;
    }
    if (ts.isObjectLiteralExpression(t)) {
      for (const prop of t.properties) {
        if (ts.isShorthandPropertyAssignment(prop)) recordWrite(prop.name);
        else if (ts.isPropertyAssignment(prop)) recordWrite(prop.initializer);
        else if (ts.isSpreadAssignment(prop)) recordWrite(prop.expression);
      }
      return;
    }
    if (ts.isBinaryExpression(t) && t.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      recordWrite(t.left);
      return;
    }
    const direct = ts.isIdentifier(t) && !mutatesValue;
    let rootExpr: ts.Expression = t;
    while (ts.isPropertyAccessExpression(rootExpr) || ts.isElementAccessExpression(rootExpr)) {
      rootExpr = skipParens(rootExpr.expression);
    }
    if (rootExpr.kind === ts.SyntaxKind.ThisKeyword) {
      sideEffect('mutates this');
      return;
    }
    if (!ts.isIdentifier(rootExpr)) {
      sideEffect(`mutates ${text(t)}`);
      return;
    }
    const decl = checker.getSymbolAtLocation(rootExpr)?.valueDeclaration;
    if (decl && isLocal(decl)) {
      if (!direct && ts.isParameter(decl)) sideEffect(`mutates parameter ${rootExpr.text}`);
      return;
    }
    sideEffect(direct ? `assigns outer variable ${rootExpr.text}` : `mutates outer ${text(t)}`);
  };

  const visitCall = (expr: ts.CallExpression) => {
    const callee = skipParens(expr.expression);
    if (ts.isIdentifier(callee) && callee.text === 'eval' && ctx.isGlobal(callee)) {
      unsupported(expr, 'eval');
      result.unknown.push('eval');
    }
    if (ts.isIdentifier(callee) && callee.text === 'Function' && ctx.isGlobal(callee)) {
      unsupported(expr, 'Function constructor');
      result.unknown.push('Function constructor');
    }
    if (callee.kind === ts.SyntaxKind.ImportKeyword) {
      unsupported(expr, 'dynamic import');
      sideEffect('dynamic import');
      call('import');
      return;
    }
    const nameNode = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
    const symbol = ctx.resolve(nameNode);
    const decl = symbol?.declarations?.[0];
    if (decl && isLocal(decl)) {
      // Local helper functions are walked as part of this body; other local callees are unknown.
      call(text(callee).slice(0, 200));
      const init = ts.isVariableDeclaration(decl) && decl.initializer ? skipParens(decl.initializer) : null;
      const walked =
        ts.isFunctionDeclaration(decl) ||
        (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)));
      if (!walked) result.unknown.push(`calls a value that is not a local function: ${text(callee)}`);
      return;
    }
    const internal = decl ? calleeSymbol(ctx, decl) : null;
    if (internal) {
      call(internal);
      result.internalCalls.push(internal);
      return;
    }
    call(text(callee).slice(0, 200));
    const fromLib = decl ? ctx.projectPath(decl.getSourceFile()) === null && isLibFile(ctx, decl) : false;
    if (
      ts.isPropertyAccessExpression(callee) &&
      MUTATING_METHODS.has(callee.name.text) &&
      (fromLib || !decl)
    ) {
      recordWrite(callee.expression, true);
    }
    if (!fromLib) result.unknown.push(`unresolved callee ${text(callee)}`);
  };

  const visit = (n: ts.Node, nestedFunction: boolean): void => {
    if (ts.isTypeNode(n) && !ts.isExpressionWithTypeArguments(n)) return;
    if (n !== node && ts.isFunctionLike(n)) {
      if (hasModifier(n, ts.SyntaxKind.AsyncKeyword)) undecidable(n, 'async function');
      if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) && n.asteriskToken) {
        undecidable(n, 'generator function');
      }
      ts.forEachChild(n, (c) => visit(c, true));
      return;
    }

    switch (n.kind) {
      case ts.SyntaxKind.ThisKeyword:
        unsupported(n, 'this');
        result.unknown.push('this');
        break;
      case ts.SyntaxKind.WithStatement:
        unsupported(n, 'with statement');
        result.unknown.push('with');
        break;
      case ts.SyntaxKind.AwaitExpression:
        undecidable(n, 'await');
        break;
      case ts.SyntaxKind.YieldExpression:
        undecidable(n, 'yield');
        break;
      case ts.SyntaxKind.BigIntLiteral:
        numeric.add('bigint');
        unsupported(n, `bigint literal ${text(n)}`);
        break;
      case ts.SyntaxKind.NumericLiteral: {
        const value = Number((n as ts.NumericLiteral).text);
        if (Number.isInteger(value)) {
          numeric.add('integer_literal');
          if (!Number.isSafeInteger(value))
            unsupported(n, `integer literal outside the safe range: ${text(n)}`);
        } else {
          numeric.add('float_literal');
          unsupported(n, `floating-point literal ${text(n)}`);
        }
        break;
      }
    }

    if (ts.isIdentifier(n) && isExpressionIdentifier(n)) {
      if ((n.text === 'NaN' || n.text === 'Infinity') && ctx.isGlobal(n)) {
        numeric.add('nan');
        unsupported(n, n.text);
      } else if (n.text === 'arguments' && ctx.isGlobal(n)) {
        undecidable(n, 'arguments object');
      } else if (IMPURE_GLOBALS.has(n.text) && ctx.isGlobal(n)) {
        sideEffect(n.text);
      } else {
        const ioModule = importedIoModule(ctx, n);
        if (ioModule) sideEffect(`io import ${ioModule}`);
      }
    }

    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && ctx.isGlobal(n.expression)) {
      const owner = n.expression.text;
      const prop = n.name.text;
      if (owner === 'Math' && prop === 'random') sideEffect('Math.random');
      else if (owner === 'Math') unsupported(n, `Math.${prop} is outside the integer model`);
      if (owner === 'Date' && prop === 'now') sideEffect('Date.now');
      if (owner === 'Number' && ['NaN', 'POSITIVE_INFINITY', 'NEGATIVE_INFINITY'].includes(prop)) {
        numeric.add('nan');
        unsupported(n, `Number.${prop}`);
      }
      if (owner === 'Proxy' && prop === 'revocable') {
        unsupported(n, 'Proxy');
        result.unknown.push('Proxy');
      }
    }

    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && ctx.isGlobal(n.expression)) {
      const ctor = n.expression.text;
      if (ctor === 'Proxy') {
        unsupported(n, 'Proxy');
        result.unknown.push('Proxy');
      } else if (ctor === 'Function') {
        unsupported(n, 'Function constructor');
        result.unknown.push('Function constructor');
      } else if (ctor === 'Date' && (n.arguments?.length ?? 0) === 0) {
        sideEffect('new Date()');
      }
    }

    if (ts.isElementAccessExpression(n)) {
      const param = isOwnParam(n.expression);
      const key = skipParens(n.argumentExpression);
      if (param && !ts.isStringLiteralLike(key) && !ts.isNumericLiteral(key)) {
        undecidable(n, `computed property access on parameter ${param}`);
      }
    }

    if (ts.isCallExpression(n)) visitCall(n);

    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) recordWrite(n.left);
      if (
        op === ts.SyntaxKind.SlashToken ||
        op === ts.SyntaxKind.SlashEqualsToken ||
        op === ts.SyntaxKind.PercentToken ||
        op === ts.SyntaxKind.PercentEqualsToken
      ) {
        numeric.add('division');
        unsupported(n, `${n.operatorToken.getText(sf)} operator`);
      }
      const comparison = COMPARISON_OPERATORS.get(op);
      if (comparison) {
        const literal = integerLiteral(n.right) ?? integerLiteral(n.left);
        const record: Comparison = {
          location: loc(sf, file, n),
          operator: comparison,
          left: text(n.left),
          right: text(n.right),
          literal,
          param: isOwnParam(n.left) ?? isOwnParam(n.right),
        };
        if (!nestedFunction) info.comparisons.push(record);
      }
      checkCoercion(n, ctx, unsupported);
    }

    if (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) {
      const op = n.operator;
      if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) recordWrite(n.operand);
      if (
        ts.isPrefixUnaryExpression(n) &&
        (op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.MinusToken) &&
        !ts.isNumericLiteral(n.operand) &&
        !isNumberLike(checker.getTypeAtLocation(n.operand))
      ) {
        unsupported(
          n,
          `implicit coercion: unary ${op === ts.SyntaxKind.PlusToken ? '+' : '-'} on a non-number`,
        );
      }
    }
    if (ts.isDeleteExpression(n)) recordWrite(n.expression);

    if (!nestedFunction) {
      if (ts.isIfStatement(n))
        info.branches.push({ location: loc(sf, file, n), condition: text(n.expression) });
      if (ts.isConditionalExpression(n)) {
        info.branches.push({ location: loc(sf, file, n), condition: text(n.condition) });
      }
      if (ts.isCaseClause(n)) {
        const subject = text(n.parent.parent.expression);
        info.branches.push({ location: loc(sf, file, n), condition: `${subject} === ${text(n.expression)}` });
      }
      if (ts.isDefaultClause(n)) info.branches.push({ location: loc(sf, file, n), condition: 'default' });
      if (ts.isWhileStatement(n) || ts.isDoStatement(n) || (ts.isForStatement(n) && n.condition)) {
        const cond = ts.isForStatement(n) ? (n.condition as ts.Expression) : n.expression;
        info.branches.push({ location: loc(sf, file, n), condition: text(cond) });
      }
      if (ts.isReturnStatement(n)) {
        info.returns.push({
          location: loc(sf, file, n),
          expression: n.expression ? text(n.expression) : 'undefined',
        });
      }
      if (ts.isThrowStatement(n))
        info.throws.push({ location: loc(sf, file, n), expression: text(n.expression) });
    }
    ts.forEachChild(n, (c) => visit(c, nestedFunction));
  };

  for (const param of node.parameters) ts.forEachChild(param, (c) => visit(c, false));
  if (node.body) {
    if (ts.isBlock(node.body)) {
      visit(node.body, false);
    } else {
      info.returns.push({ location: loc(sf, file, node.body), expression: text(node.body) });
      visit(node.body, false);
    }
  }

  info.numericKinds = NUMERIC_KIND_ORDER.filter((k) => numeric.has(k));
  info.unsupported.sort(
    (a, b) =>
      (a.location.range?.start ?? 0) - (b.location.range?.start ?? 0) || a.reason.localeCompare(b.reason),
  );
  return result;
}

function checkCoercion(
  n: ts.BinaryExpression,
  ctx: Context,
  unsupported: (at: ts.Node, reason: string) => void,
): void {
  const op = n.operatorToken.kind;
  const left = ctx.checker.getTypeAtLocation(n.left);
  const right = ctx.checker.getTypeAtLocation(n.right);
  const opText = ts.tokenToString(op) ?? '';
  if (op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) {
    const l = categories(left);
    const r = categories(right);
    if (l === null || r === null || l !== r) {
      unsupported(n, `implicit coercion: ${opText} between different or unknown types`);
    }
    return;
  }
  if (
    op === ts.SyntaxKind.LessThanToken ||
    op === ts.SyntaxKind.LessThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanToken ||
    op === ts.SyntaxKind.GreaterThanEqualsToken
  ) {
    const l = categories(left);
    const r = categories(right);
    if (l === null || r === null || l !== r) {
      unsupported(n, `implicit coercion: ${opText} between different or unknown types`);
    }
    return;
  }
  if (op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.PlusEqualsToken) {
    const bothNumbers = isNumberLike(left) && isNumberLike(right);
    const bothBigInt = isBigIntLike(left) && isBigIntLike(right);
    const bothStrings = isStringLike(left) && isStringLike(right);
    if (!bothNumbers && !bothBigInt && !bothStrings) {
      unsupported(n, `implicit coercion: ${opText} on mixed or non-numeric operands`);
    }
    return;
  }
  if (ARITHMETIC_OPERATORS.has(op)) {
    const ok = (isNumberLike(left) && isNumberLike(right)) || (isBigIntLike(left) && isBigIntLike(right));
    if (!ok) unsupported(n, `implicit coercion: ${opText} on non-numeric operands`);
  }
}

/** Sorted primitive categories of a type, or null when it is any/unknown/an object. */
function categories(type: ts.Type): string | null {
  const parts = type.isUnion() ? type.types : [type];
  const out = new Set<string>();
  for (const t of parts) {
    const f = t.flags;
    if (f & ts.TypeFlags.NumberLike) out.add('number');
    else if (f & ts.TypeFlags.StringLike) out.add('string');
    else if (f & ts.TypeFlags.BooleanLike) out.add('boolean');
    else if (f & ts.TypeFlags.BigIntLike) out.add('bigint');
    else if (f & ts.TypeFlags.Null) out.add('null');
    else if (f & ts.TypeFlags.Undefined) out.add('undefined');
    else return null;
  }
  return [...out].sort().join('|');
}

const isNumberLike = (t: ts.Type) => categories(t) === 'number';
const isBigIntLike = (t: ts.Type) => categories(t) === 'bigint';
const isStringLike = (t: ts.Type) => categories(t) === 'string';

/** Decimal text of an integer literal (optionally negated), e.g. `0x10` -> `16`, `-1_000` -> `-1000`. */
function integerLiteral(expr: ts.Expression): string | null {
  let e = skipParens(expr);
  let sign = '';
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken) {
    sign = '-';
    e = skipParens(e.operand);
  }
  if (!ts.isNumericLiteral(e)) return null;
  const raw = e.getText().replace(/_/g, '');
  const value = Number(raw);
  if (!Number.isInteger(value)) return null;
  let digits: string;
  if (/^0[xob]/i.test(raw) || /^\d+$/.test(raw)) digits = BigInt(raw).toString();
  else if (Number.isSafeInteger(value)) digits = String(value);
  else return null;
  return digits === '0' ? '0' : `${sign}${digits}`;
}

function importedIoModule(ctx: Context, identifier: ts.Identifier): string | null {
  const symbol = ctx.checker.getSymbolAtLocation(identifier);
  for (const decl of symbol?.declarations ?? []) {
    if (!isImport(decl)) continue;
    let n: ts.Node = decl;
    while (!ts.isImportDeclaration(n) && !ts.isImportEqualsDeclaration(n) && n.parent) n = n.parent;
    let specifier: string | null = null;
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier))
      specifier = n.moduleSpecifier.text;
    if (
      ts.isImportEqualsDeclaration(n) &&
      ts.isExternalModuleReference(n.moduleReference) &&
      ts.isStringLiteral(n.moduleReference.expression)
    ) {
      specifier = n.moduleReference.expression.text;
    }
    if (specifier && IO_MODULES.has(specifier.replace(/^node:/, ''))) return specifier;
  }
  return null;
}

function isImport(decl: ts.Node): boolean {
  return (
    ts.isImportSpecifier(decl) ||
    ts.isImportClause(decl) ||
    ts.isNamespaceImport(decl) ||
    ts.isImportEqualsDeclaration(decl)
  );
}

function isLibFile(ctx: Context, decl: ts.Node): boolean {
  return ctx.program.isSourceFileDefaultLibrary(decl.getSourceFile());
}

/** Identifiers in value positions: not property names, declaration names or labels. */
function isExpressionIdentifier(n: ts.Identifier): boolean {
  const p = n.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === n) return false;
  if (ts.isQualifiedName(p)) return false;
  if (
    (ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p)) &&
    p.name === n
  ) {
    return false;
  }
  if (ts.isBindingElement(p) && p.propertyName === n) return false;
  if ((ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) && p.label === n) return false;
  if ((p as { name?: ts.Node }).name === n && !ts.isShorthandPropertyAssignment(p)) return false;
  return true;
}

function returnTypeOf(checker: ts.TypeChecker, node: FunctionNode): string {
  const signature = checker.getSignatureFromDeclaration(node);
  if (!signature) return 'unknown';
  return checker.typeToString(
    checker.getReturnTypeOfSignature(signature),
    node,
    ts.TypeFormatFlags.NoTruncation,
  );
}

function jsdocOf(sf: ts.SourceFile, target: FunctionTarget): string | null {
  const host = ts.isVariableDeclaration(target.declaration)
    ? outerStatement(target.declaration)
    : ts.isExportAssignment(target.declaration)
      ? target.declaration
      : target.node;
  const docs = (host as { jsDoc?: ts.JSDoc[] }).jsDoc;
  if (!docs?.length) return null;
  const text = docs
    .map((doc) =>
      sf.text
        .slice(doc.pos, doc.end)
        .replace(/^\/\*\*/, '')
        .replace(/\*\/$/, '')
        .split('\n')
        .map((line) => line.replace(/^\s*\*?\s?/, '').trimEnd())
        .join('\n')
        .trim(),
    )
    .filter(Boolean)
    .join('\n');
  return text || null;
}

function outerStatement(node: ts.Node): ts.Node {
  if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent)) {
    return ts.isVariableStatement(node.parent.parent) ? node.parent.parent : node;
  }
  return node;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

function skipParens(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e))
    e = e.expression;
  return e;
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function loc(sf: ts.SourceFile, file: string, node: ts.Node): Location {
  return {
    file,
    range: { start: lineOf(sf, node), end: sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1 },
  };
}

/** Disambiguate symbol ids that collide (e.g. a duplicated declaration in a broken file). */
function dedupeSymbols(indexed: Indexed[], diagnostics: CodeIndex['diagnostics']): void {
  const seen = new Map<string, number>();
  for (const entry of indexed) {
    const count = (seen.get(entry.info.symbol) ?? 0) + 1;
    seen.set(entry.info.symbol, count);
    if (count > 1) {
      diagnostics.push({
        file: entry.info.file,
        message: `duplicate symbol ${entry.info.symbol} at line ${entry.info.location.range?.start}; indexed as ~${count}`,
      });
      entry.info.symbol = `${entry.info.symbol}~${count}`;
    }
  }
}

/** Direct effects make a function impure; calls into impure or unknown project functions propagate. */
function propagatePurity(indexed: Indexed[]): void {
  const bySymbol = new Map(indexed.map((i) => [i.info.symbol, i]));
  for (const entry of indexed) {
    entry.info.purity =
      entry.info.sideEffects.length > 0 ? 'impure' : entry.unknown.length > 0 ? 'unknown' : 'pure';
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const entry of indexed) {
      for (const callee of entry.internalCalls) {
        const target = bySymbol.get(callee);
        const purity = target?.info.purity ?? 'unknown';
        if (purity === 'impure' && entry.info.purity !== 'impure') {
          entry.info.sideEffects.push(`calls impure ${callee}`);
          entry.info.purity = 'impure';
          changed = true;
        } else if (purity === 'unknown' && entry.info.purity === 'pure') {
          entry.info.purity = 'unknown';
          changed = true;
        }
      }
    }
  }
}
