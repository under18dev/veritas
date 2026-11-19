import {
  type Expr,
  type FunctionModel,
  type IntDomain,
  type Param,
  type Sort,
  symbolId,
} from '@under18dev/veritas-core';
import ts from 'typescript';

export interface UnsupportedReason {
  line: number;
  construct: string;
  reason: string;
}

export type TranslationResult =
  | { status: 'translated'; model: FunctionModel; params: Param[]; dependencies: FunctionModel[] }
  | { status: 'unsupported'; symbol: string; reasons: UnsupportedReason[] }
  | { status: 'not_found'; symbol: string };

export interface TranslateOptions {
  /** Posix path relative to the project root, used for symbol ids. */
  file: string;
  source: string;
  exportName: string;
  /** Domain for every integer parameter. */
  domain: IntDomain;
  /** Name given to the model in the IR (defaults to the export name). */
  modelName?: string;
}

class Unsupported extends Error {
  constructor(
    readonly node: ts.Node,
    readonly construct: string,
    reason: string,
  ) {
    super(reason);
  }
}

const SAFE = 9007199254740991n;

const BINARY: Partial<Record<ts.SyntaxKind, Extract<Expr, { kind: 'binary' }>['op']>> = {
  [ts.SyntaxKind.PlusToken]: '+',
  [ts.SyntaxKind.MinusToken]: '-',
  [ts.SyntaxKind.AsteriskToken]: '*',
  [ts.SyntaxKind.LessThanToken]: '<',
  [ts.SyntaxKind.LessThanEqualsToken]: '<=',
  [ts.SyntaxKind.GreaterThanToken]: '>',
  [ts.SyntaxKind.GreaterThanEqualsToken]: '>=',
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: '==',
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]: '!=',
  [ts.SyntaxKind.AmpersandAmpersandToken]: 'and',
  [ts.SyntaxKind.BarBarToken]: 'or',
};

const REJECTED_BINARY: Partial<Record<ts.SyntaxKind, string>> = {
  [ts.SyntaxKind.SlashToken]: 'division produces fractions in JavaScript; integer division semantics differ',
  [ts.SyntaxKind.PercentToken]: 'JavaScript remainder differs from SMT modulo for negative operands',
  [ts.SyntaxKind.AsteriskAsteriskToken]:
    'exponentiation can leave the safe-integer range and is not modelled',
  [ts.SyntaxKind.EqualsEqualsToken]: 'loose equality performs implicit coercion',
  [ts.SyntaxKind.ExclamationEqualsToken]: 'loose inequality performs implicit coercion',
  [ts.SyntaxKind.QuestionQuestionToken]: 'nullish values are outside the supported subset',
};

function sortOfType(node: ts.TypeNode | undefined, what: string, owner: ts.Node): Sort {
  if (node?.kind === ts.SyntaxKind.NumberKeyword) return 'int';
  if (node?.kind === ts.SyntaxKind.BooleanKeyword) return 'bool';
  throw new Unsupported(node ?? owner, 'type', `${what} must be annotated as number or boolean`);
}

/** Find an exported function declaration or exported `const name = (...) => ...`. */
function findFunction(sf: ts.SourceFile, name: string): ts.FunctionLikeDeclaration | null {
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) return stmt;
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) {
          if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
            return decl.initializer;
        }
      }
    }
  }
  return null;
}

interface Scope {
  sf: ts.SourceFile;
  vars: Map<string, Expr>;
  /** Sorts of the function parameters. */
  paramSorts: Map<string, Sort>;
  functions: Map<string, FunctionModel>;
  translateCallee: (name: string) => FunctionModel;
}

function expr(node: ts.Expression, scope: Scope): Expr {
  if (ts.isParenthesizedExpression(node)) return expr(node.expression, scope);
  if (ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) {
    throw new Unsupported(node, 'cast', 'type assertions can hide non-integer values');
  }
  if (ts.isNumericLiteral(node)) {
    const text = node.text;
    if (!/^\d+$/.test(text))
      throw new Unsupported(node, 'number', `non-integer literal ${node.getText(scope.sf)}`);
    if (BigInt(text) > SAFE) throw new Unsupported(node, 'number', 'literal outside the safe-integer range');
    return { kind: 'int', value: text };
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { kind: 'bool', value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'bool', value: false };
  if (ts.isIdentifier(node)) {
    if (node.text === 'NaN' || node.text === 'Infinity' || node.text === 'undefined') {
      throw new Unsupported(node, node.text, `${node.text} is not an integer or boolean`);
    }
    const bound = scope.vars.get(node.text);
    if (!bound)
      throw new Unsupported(
        node,
        'identifier',
        `reference to ${node.text}, which is not a parameter or local constant`,
      );
    return bound;
  }
  if (ts.isPrefixUnaryExpression(node)) {
    if (node.operator === ts.SyntaxKind.ExclamationToken)
      return { kind: 'unary', op: 'not', arg: expr(node.operand, scope) };
    if (node.operator === ts.SyntaxKind.MinusToken) {
      if (ts.isNumericLiteral(node.operand)) {
        const inner = expr(node.operand, scope) as { kind: 'int'; value: string };
        return inner.value === '0' ? inner : { kind: 'int', value: `-${inner.value}` };
      }
      return { kind: 'unary', op: 'neg', arg: expr(node.operand, scope) };
    }
    throw new Unsupported(
      node,
      'unary',
      `unary ${ts.tokenToString(node.operator)} is not supported (coercion or mutation)`,
    );
  }
  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    const rejected = REJECTED_BINARY[kind];
    if (rejected) throw new Unsupported(node, ts.tokenToString(kind) ?? 'operator', rejected);
    const op = BINARY[kind];
    if (!op)
      throw new Unsupported(
        node,
        ts.tokenToString(kind) ?? 'operator',
        'operator is not supported (assignment or bitwise)',
      );
    return { kind: 'binary', op, left: expr(node.left, scope), right: expr(node.right, scope) };
  }
  if (ts.isConditionalExpression(node)) {
    return {
      kind: 'ite',
      cond: expr(node.condition, scope),
      whenTrue: expr(node.whenTrue, scope),
      whenFalse: expr(node.whenFalse, scope),
    };
  }
  if (ts.isCallExpression(node)) {
    if (!ts.isIdentifier(node.expression)) {
      throw new Unsupported(
        node,
        'call',
        `call to ${node.expression.getText(scope.sf)} is outside the supported subset`,
      );
    }
    const callee = scope.translateCallee(node.expression.text);
    return { kind: 'call', fn: callee.name, args: node.arguments.map((a) => expr(a, scope)) };
  }
  if (ts.isAwaitExpression(node)) throw new Unsupported(node, 'await', 'asynchronous code is not supported');
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    throw new Unsupported(
      node,
      'property access',
      `${node.getText(scope.sf)} is outside the supported subset`,
    );
  }
  throw new Unsupported(
    node,
    ts.SyntaxKind[node.kind],
    `${ts.SyntaxKind[node.kind]} is outside the supported subset`,
  );
}

/** Translate a statement list into one expression; every path must end in `return`. */
function statements(stmts: readonly ts.Statement[], scope: Scope, owner: ts.Node): Expr {
  const [first, ...rest] = stmts;
  if (!first)
    throw new Unsupported(owner, 'missing return', 'a path through the function does not return a value');
  if (ts.isReturnStatement(first)) {
    if (!first.expression) throw new Unsupported(first, 'return', 'return without a value');
    return expr(first.expression, scope);
  }
  if (ts.isBlock(first)) return statements([...first.statements, ...rest], scope, owner);
  if (ts.isIfStatement(first)) {
    const cond = expr(first.expression, scope);
    const thenStmts = ts.isBlock(first.thenStatement)
      ? [...first.thenStatement.statements]
      : [first.thenStatement];
    const elseStmts = first.elseStatement
      ? ts.isBlock(first.elseStatement)
        ? [...first.elseStatement.statements]
        : [first.elseStatement]
      : [];
    return {
      kind: 'ite',
      cond,
      whenTrue: statements([...thenStmts, ...rest], { ...scope, vars: new Map(scope.vars) }, first),
      whenFalse: statements([...elseStmts, ...rest], { ...scope, vars: new Map(scope.vars) }, first),
    };
  }
  if (ts.isVariableStatement(first)) {
    if (!(first.declarationList.flags & ts.NodeFlags.Const)) {
      throw new Unsupported(first, 'let/var', 'mutable variables are not supported; use const');
    }
    const vars = new Map(scope.vars);
    for (const decl of first.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer)
        throw new Unsupported(decl, 'declaration', 'destructuring or uninitialised const');
      vars.set(decl.name.text, expr(decl.initializer, { ...scope, vars }));
    }
    return statements(rest, { ...scope, vars }, owner);
  }
  if (ts.isEmptyStatement(first)) return statements(rest, scope, owner);
  const construct = ts.SyntaxKind[first.kind];
  throw new Unsupported(
    first,
    construct,
    `${construct} is outside the supported subset (loops, throw, side effects)`,
  );
}

/**
 * Translate an exported pure function in the supported subset (see docs/semantics.md) into an IR function
 * model. Anything outside the subset is reported with its line, never approximated.
 */
export function translateFunction(options: TranslateOptions): TranslationResult {
  const sf = ts.createSourceFile(
    options.file,
    options.source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const id = symbolId(options.file, options.exportName);
  const reasons: UnsupportedReason[] = [];
  const models = new Map<string, FunctionModel>();
  const inProgress = new Set<string>();
  const rootModel = options.modelName ?? options.exportName;
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const translateNamed = (name: string, modelName: string): FunctionModel => {
    const existing = models.get(modelName);
    if (existing) return existing;
    if (inProgress.has(name)) throw new Unsupported(sf, 'recursion', `recursive call to ${name}`);
    const fn = findFunction(sf, name);
    if (!fn) throw new Unsupported(sf, 'call', `${name} is not a function declared in ${options.file}`);
    if (fn.asteriskToken) throw new Unsupported(fn, 'generator', 'generators are not supported');
    if (fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword))
      throw new Unsupported(fn, 'async', 'async functions are not supported');
    inProgress.add(name);
    const paramSorts = new Map<string, Sort>();
    const vars = new Map<string, Expr>();
    const params = fn.parameters.map((p) => {
      if (!ts.isIdentifier(p.name))
        throw new Unsupported(p, 'destructuring', 'destructured parameters are not supported');
      if (p.questionToken || p.initializer || p.dotDotDotToken) {
        throw new Unsupported(p, 'parameter', 'optional, default and rest parameters can be undefined');
      }
      const sort = sortOfType(p.type, `parameter ${p.name.text}`, p);
      paramSorts.set(p.name.text, sort);
      vars.set(p.name.text, { kind: 'var', name: p.name.text });
      return { name: p.name.text, sort };
    });
    const returns = sortOfType(fn.type, `return type of ${name}`, fn);
    const scope: Scope = {
      sf,
      vars,
      paramSorts,
      functions: models,
      // Callees are namespaced per root model so an original and a mutant can coexist in one query.
      translateCallee: (callee) => translateNamed(callee, `${rootModel}__${callee}`),
    };
    const body = fn.body
      ? ts.isBlock(fn.body)
        ? statements(fn.body.statements, scope, fn)
        : expr(fn.body, scope)
      : (() => {
          throw new Unsupported(fn, 'declaration', 'function has no body');
        })();
    inProgress.delete(name);
    const model: FunctionModel = {
      name: modelName,
      symbol: symbolId(options.file, name),
      params,
      returns,
      body,
    };
    models.set(modelName, model);
    return model;
  };

  if (!findFunction(sf, options.exportName)) return { status: 'not_found', symbol: id };
  const fn = findFunction(sf, options.exportName) as ts.FunctionLikeDeclaration;
  let model: FunctionModel;
  try {
    model = translateNamed(options.exportName, options.modelName ?? options.exportName);
  } catch (error) {
    if (error instanceof Unsupported) {
      reasons.push({
        line: error.node === sf ? line(fn) : line(error.node),
        construct: error.construct,
        reason: error.message,
      });
      return { status: 'unsupported', symbol: id, reasons };
    }
    throw error;
  }
  const params: Param[] = model.params.map((p) =>
    p.sort === 'int' ? { name: p.name, sort: 'int', domain: options.domain } : { name: p.name, sort: 'bool' },
  );
  const dependencies = [...models.values()].filter((m) => m !== model);
  return { status: 'translated', model, params, dependencies };
}
