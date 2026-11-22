import {
  type Expr,
  type FunctionModel,
  type IntDomain,
  type JsParam,
  type Param,
  type Sort,
  symbolId,
} from '@under18dev/veritas-core';
import ts from 'typescript';
import { substitute } from './shapes.js';

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
  /** Element slots modelled for an array parameter (its length ranges over [0, maxArrayLength]). Default 3. */
  maxArrayLength?: number;
}

/** Separator between a record or array parameter and its field or slot in the flattened model parameters. */
export const FLAT_SEPARATOR = '__';

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
  const declared = node ? ` (declared ${node.getText()})` : '';
  throw new Unsupported(node ?? owner, 'type', `${what} must be annotated as number or boolean${declared}`);
}

type ParamShape =
  | { kind: 'scalar'; sort: Sort }
  | { kind: 'record'; fields: { key: string; sort: Sort }[] }
  | { kind: 'array'; sort: Sort };

/** Members of an object type literal or interface; every member must be a number or boolean property. */
function recordFields(
  members: ts.NodeArray<ts.TypeElement>,
  what: string,
  owner: ts.Node,
): { key: string; sort: Sort }[] {
  const fields = members.map((m) => {
    if (!ts.isPropertySignature(m) || !m.name || !(ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)))
      throw new Unsupported(m, 'record', `${what}: only named number or boolean properties are supported`);

    if (m.questionToken)
      throw new Unsupported(m, 'record', `${what}: optional property ${m.name.text} can be undefined`);

    if (!/^[A-Za-z_$][\w$]*$/.test(m.name.text))
      throw new Unsupported(m, 'record', `${what}: property name ${m.name.text} is not a plain identifier`);

    // In an object literal, `__proto__: v` sets the prototype instead of making a property, so the model and
    // JavaScript would read different values.
    if (m.name.text === '__proto__')
      throw new Unsupported(m, 'record', `${what}: property __proto__ is the prototype in an object literal`);

    return { key: m.name.text, sort: sortOfType(m.type, `property ${m.name.text} of ${what}`, m) };
  });

  if (fields.length === 0) throw new Unsupported(owner, 'record', `${what} has no properties`);

  return fields;
}

/**
 * The shape of a parameter type: number, boolean, a record of number/boolean properties (type literal, or an
 * interface or type alias declared in the same file) or an array of numbers or booleans.
 */
function shapeOfType(
  node: ts.TypeNode | undefined,
  what: string,
  owner: ts.Node,
  sf: ts.SourceFile,
): ParamShape {
  if (!node) throw new Unsupported(owner, 'type', `${what} must have a type annotation`);

  if (node.kind === ts.SyntaxKind.NumberKeyword) return { kind: 'scalar', sort: 'int' };

  if (node.kind === ts.SyntaxKind.BooleanKeyword) return { kind: 'scalar', sort: 'bool' };

  if (ts.isParenthesizedTypeNode(node)) return shapeOfType(node.type, what, owner, sf);

  if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword)
    return shapeOfType(node.type, what, owner, sf);

  if (ts.isArrayTypeNode(node))
    return { kind: 'array', sort: sortOfType(node.elementType, `elements of ${what}`, node) };

  if (ts.isTypeLiteralNode(node)) return { kind: 'record', fields: recordFields(node.members, what, node) };

  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const name = node.typeName.text;

    if ((name === 'Array' || name === 'ReadonlyArray') && node.typeArguments?.length === 1)
      return { kind: 'array', sort: sortOfType(node.typeArguments[0], `elements of ${what}`, node) };

    if (name === 'Readonly' && node.typeArguments?.length === 1)
      return shapeOfType(node.typeArguments[0], what, owner, sf);

    if (!node.typeArguments) {
      for (const stmt of sf.statements) {
        if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === name) {
          if (stmt.heritageClauses?.length || stmt.typeParameters?.length)
            throw new Unsupported(stmt, 'record', `interface ${name} extends or is generic`);

          return { kind: 'record', fields: recordFields(stmt.members, what, stmt) };
        }

        if (ts.isTypeAliasDeclaration(stmt) && stmt.name.text === name && !stmt.typeParameters) {
          return shapeOfType(stmt.type, what, stmt, sf);
        }
      }
    }
  }
  throw new Unsupported(
    node,
    'type',
    `${what} must be number, boolean, a record of number/boolean properties or an array of numbers or booleans`,
  );
}

/** A record or array parameter: what its fields, length and element slots are called in the model. */
type Aggregate =
  | { kind: 'record'; name: string; fields: Map<string, { param: string; sort: Sort }> }
  | { kind: 'array'; name: string; length: string; elements: string[]; sort: Sort };

const and = (left: Expr, right: Expr): Expr => ({ kind: 'binary', op: 'and', left, right });
const not = (arg: Expr): Expr => ({ kind: 'unary', op: 'not', arg });

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
  /** Sorts of the model parameters (record fields and array slots flattened). */
  paramSorts: Map<string, Sort>;
  functions: Map<string, FunctionModel>;
  translateCallee: (name: string) => FunctionModel;
  /** Record and array parameters still visible (not shadowed by a local constant). */
  aggregates: Map<string, Aggregate>;
  /** Conditions known to hold where the expression is evaluated (if/ternary branches, `&&`/`||` operands). */
  path: Expr[];
  /** Collects, per element read, the condition under which it reads at or beyond the array's length. */
  outOfBounds: Expr[];
}

function pathCondition(path: Expr[]): Expr {
  return path.reduce((a, b) => and(a, b), { kind: 'bool', value: true } as Expr);
}

function aggregateOf(node: ts.Expression, scope: Scope): Aggregate | undefined {
  return ts.isIdentifier(node) ? scope.aggregates.get(node.text) : undefined;
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

    if (scope.aggregates.has(node.text))
      throw new Unsupported(
        node,
        'record/array',
        `${node.text} can only be read by property, .length or a literal index (passing, returning or copying it is not supported)`,
      );
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
    const left = expr(node.left, scope);
    // The right operand of && / || is only evaluated when the left one is true / false.
    const rightPath =
      op === 'and' ? [...scope.path, left] : op === 'or' ? [...scope.path, not(left)] : scope.path;

    return { kind: 'binary', op, left, right: expr(node.right, { ...scope, path: rightPath }) };
  }

  if (ts.isConditionalExpression(node)) {
    const cond = expr(node.condition, scope);

    return {
      kind: 'ite',
      cond,
      whenTrue: expr(node.whenTrue, { ...scope, path: [...scope.path, cond] }),
      whenFalse: expr(node.whenFalse, { ...scope, path: [...scope.path, not(cond)] }),
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
    return call(node, node.expression.text, scope);
  }

  if (ts.isObjectLiteralExpression(node))
    throw new Unsupported(
      node,
      'object literal',
      'object literals are only supported as the record argument of a call to a function in the same file',
    );

  if (ts.isArrayLiteralExpression(node))
    throw new Unsupported(node, 'array literal', 'array literals are outside the supported subset');

  if (ts.isAwaitExpression(node)) throw new Unsupported(node, 'await', 'asynchronous code is not supported');

  if (ts.isPropertyAccessExpression(node) && !node.questionDotToken) {
    const target = aggregateOf(node.expression, scope);
    const key = node.name.text;

    if (target?.kind === 'record') {
      const field = target.fields.get(key);

      if (field) return { kind: 'var', name: field.param };
    }

    if (target?.kind === 'array' && key === 'length') return { kind: 'var', name: target.length };
  }

  if (ts.isElementAccessExpression(node) && !node.questionDotToken) {
    const target = aggregateOf(node.expression, scope);
    const index = node.argumentExpression;

    if (target?.kind === 'array' && ts.isNumericLiteral(index) && /^\d+$/.test(index.text)) {
      const k = Number(index.text);
      const slot = target.elements[k];

      if (slot === undefined)
        throw new Unsupported(
          node,
          'element access',
          `index ${k} is beyond the ${target.elements.length} element slot(s) modelled for ${target.name} (formal.maxArrayLength)`,
        );
      // Reading at or beyond the length gives undefined in JavaScript: record where that can happen.
      scope.outOfBounds.push(
        and(pathCondition(scope.path), {
          kind: 'binary',
          op: '<=',
          left: { kind: 'var', name: target.length },
          right: { kind: 'int', value: String(k) },
        }),
      );

      return { kind: 'var', name: slot };
    }
  }

  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    throw new Unsupported(
      node,
      'property access',
      `${node.getText(scope.sf)} is outside the supported subset (only fields of record parameters, .length and literal indexes of array parameters)`,
    );
  }
  throw new Unsupported(
    node,
    ts.SyntaxKind[node.kind],
    `${ts.SyntaxKind[node.kind]} is outside the supported subset`,
  );
}

const SORT_NAME: Record<Sort, string> = { int: 'number', bool: 'boolean' };

/** The sort of a translated expression (the IR is checked again before it reaches a solver). */
function sortOf(e: Expr, scope: Scope): Sort | undefined {
  switch (e.kind) {
    case 'int':
      return 'int';
    case 'bool':
      return 'bool';
    case 'var':
      return scope.paramSorts.get(e.name);
    case 'unary':
      return e.op === 'neg' ? 'int' : 'bool';
    case 'binary':
      return ['+', '-', '*', 'div', 'mod'].includes(e.op) ? 'int' : 'bool';
    case 'ite':
      return sortOf(e.whenTrue, scope);
    case 'call':
      return scope.functions.get(e.fn)?.returns;
  }
}

function expectSort(node: ts.Node, e: Expr, sort: Sort, what: string, scope: Scope): Expr {
  const actual = sortOf(e, scope);

  if (actual !== sort)
    throw new Unsupported(
      node,
      'call',
      `${what} must be a ${SORT_NAME[sort]}${actual ? `, but ${node.getText(scope.sf)} is a ${SORT_NAME[actual]}` : ''}`,
    );

  return e;
}

/** A plain identifier property key of an object literal, or undefined for computed or unusual keys. */
function literalKey(name: ts.PropertyName): string | undefined {
  if ((ts.isIdentifier(name) || ts.isStringLiteral(name)) && /^[A-Za-z_$][\w$]*$/.test(name.text))
    return name.text;

  return undefined;
}

/**
 * The flattened values of a record argument, in the order of the callee's fields. The argument must be a record
 * parameter with exactly the callee's fields and sorts, or an object literal that lists exactly those fields once.
 * The subset has no mutation, so passing a record by reference cannot change what the callee reads.
 */
function recordArgument(
  arg: ts.Expression,
  param: Extract<JsParam, { kind: 'record' }>,
  sorts: Map<string, Sort>,
  callee: string,
  scope: Scope,
): Expr[] {
  const what = `parameter ${param.name} of ${callee}`;
  const keys = new Set(param.fields.map((f) => f.key));
  const fail = (node: ts.Node, reason: string): never => {
    throw new Unsupported(node, 'record argument', `${reason} (${what} takes { ${[...keys].join(', ')} })`);
  };
  const node = skipParentheses(arg);

  if (ts.isIdentifier(node)) {
    const target = scope.aggregates.get(node.text);

    if (target?.kind !== 'record')
      fail(
        node,
        `${node.text} is not a record parameter; pass a record parameter or an object literal with the same fields`,
      );
    const record = target as Extract<Aggregate, { kind: 'record' }>;

    for (const key of record.fields.keys())
      if (!keys.has(key)) fail(node, `${node.text} has property ${key}, which ${what} does not declare`);

    return param.fields.map((f) => {
      const field = record.fields.get(f.key);

      if (!field) return fail(node, `${node.text} lacks property ${f.key}`);
      const sort = sorts.get(f.param) as Sort;

      if (field.sort !== sort)
        fail(
          node,
          `property ${f.key} of ${node.text} is a ${SORT_NAME[field.sort]}, but ${what} declares a ${SORT_NAME[sort]}`,
        );

      return { kind: 'var', name: field.param };
    });
  }

  if (!ts.isObjectLiteralExpression(node))
    return fail(
      node,
      `${node.getText(scope.sf)} is neither a record parameter nor an object literal; only those can be passed as a record`,
    );
  const values = new Map<string, Expr>();

  for (const prop of node.properties) {
    if (ts.isSpreadAssignment(prop)) fail(prop, 'spread properties are not supported in a record argument');

    if (ts.isShorthandPropertyAssignment(prop) && prop.objectAssignmentInitializer)
      fail(prop, 'shorthand properties with a default are not supported');

    if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop))
      fail(prop, 'methods and accessors are not supported in a record argument');
    const named = prop as ts.PropertyAssignment | ts.ShorthandPropertyAssignment;
    const key = literalKey(named.name);

    if (key === undefined)
      fail(prop, `property key ${named.name.getText(scope.sf)} is computed or not a plain identifier`);
    const k = key as string;

    if (values.has(k)) fail(prop, `property ${k} is given twice`);

    if (!keys.has(k)) fail(prop, `property ${k} is not declared by ${what}`);
    const field = param.fields.find((f) => f.key === k) as { key: string; param: string };
    const value = ts.isPropertyAssignment(named) ? named.initializer : named.name;
    values.set(
      k,
      expectSort(
        value,
        expr(value, scope),
        sorts.get(field.param) as Sort,
        `property ${k} of ${what}`,
        scope,
      ),
    );
  }

  return param.fields.map((f) => values.get(f.key) ?? fail(node, `property ${f.key} is missing`));
}

/** The flattened values of an array argument: an array parameter with the same element type. */
function arrayArgument(
  arg: ts.Expression,
  param: Extract<JsParam, { kind: 'array' }>,
  sorts: Map<string, Sort>,
  callee: string,
  scope: Scope,
): Expr[] {
  const node = skipParentheses(arg);
  const target = ts.isIdentifier(node) ? scope.aggregates.get(node.text) : undefined;
  const sort = sorts.get(param.elements[0] as string) as Sort;
  const what = `parameter ${param.name} of ${callee}`;

  if (target?.kind !== 'array')
    throw new Unsupported(
      node,
      'array argument',
      `${node.getText(scope.sf)} is not an array parameter; only an array parameter can be passed as ${what}`,
    );

  if (target.sort !== sort)
    throw new Unsupported(
      node,
      'array argument',
      `${target.name} holds ${SORT_NAME[target.sort]}s, but ${what} holds ${SORT_NAME[sort]}s`,
    );

  if (target.elements.length !== param.elements.length)
    throw new Unsupported(
      node,
      'array argument',
      `${target.name} and ${what} model different numbers of slots`,
    );

  return [target.length, ...target.elements].map((name) => ({ kind: 'var', name }));
}

function skipParentheses(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ? skipParentheses(node.expression) : node;
}

/**
 * A call to a function in the same file. Record and array arguments are passed as their flattened values, and
 * the callee's out-of-bounds conditions are carried over to the caller with the arguments substituted.
 */
function call(node: ts.CallExpression, name: string, scope: Scope): Expr {
  const callee = scope.translateCallee(name);
  const shapes: JsParam[] =
    callee.jsParams ?? callee.params.map((p) => ({ kind: 'scalar', name: p.name, param: p.name }));

  if (node.arguments.length !== shapes.length)
    throw new Unsupported(
      node,
      'call',
      `${name} takes ${shapes.length} argument(s) but is called with ${node.arguments.length}`,
    );
  const sorts = new Map(callee.params.map((p) => [p.name, p.sort]));
  const args = shapes.flatMap((shape, i): Expr[] => {
    const arg = node.arguments[i] as ts.Expression;

    if (ts.isSpreadElement(arg)) throw new Unsupported(arg, 'spread', 'spread arguments are not supported');

    if (shape.kind === 'record') return recordArgument(arg, shape, sorts, name, scope);

    if (shape.kind === 'array') return arrayArgument(arg, shape, sorts, name, scope);

    return [
      expectSort(
        arg,
        expr(arg, scope),
        sorts.get(shape.param) as Sort,
        `argument ${shape.name} of ${name}`,
        scope,
      ),
    ];
  });

  if (callee.outOfBounds?.length) {
    const subst = new Map(callee.params.map((p, i) => [p.name, args[i] as Expr]));

    for (const c of callee.outOfBounds)
      scope.outOfBounds.push(and(pathCondition(scope.path), substitute(c, subst)));
  }

  return { kind: 'call', fn: callee.name, args };
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
    const negated = not(cond);
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
      whenTrue: statements(
        [...thenStmts, ...rest],
        { ...scope, vars: new Map(scope.vars), path: [...scope.path, cond] },
        first,
      ),
      whenFalse: statements(
        [...elseStmts, ...rest],
        { ...scope, vars: new Map(scope.vars), path: [...scope.path, negated] },
        first,
      ),
    };
  }

  if (ts.isVariableStatement(first)) {
    if (!(first.declarationList.flags & ts.NodeFlags.Const)) {
      throw new Unsupported(first, 'let/var', 'mutable variables are not supported; use const');
    }
    const vars = new Map(scope.vars);
    const aggregates = new Map(scope.aggregates);

    for (const decl of first.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer)
        throw new Unsupported(decl, 'declaration', 'destructuring or uninitialised const');
      vars.set(decl.name.text, expr(decl.initializer, { ...scope, vars, aggregates }));
      // A local constant shadows a record or array parameter of the same name.
      aggregates.delete(decl.name.text);
    }

    return statements(rest, { ...scope, vars, aggregates }, owner);
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
 * Translate an exported pure function in the supported subset (see docs/concepts/semantics.md) into an IR function
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
  const maxArrayLength = options.maxArrayLength ?? 3;

  if (!Number.isInteger(maxArrayLength) || maxArrayLength < 1 || maxArrayLength > 8)
    throw new RangeError('maxArrayLength must be an integer from 1 to 8');
  /** Array length parameters: their domain is [0, maxArrayLength], not the integer domain. */
  const lengths = new Set<string>();
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
    const aggregates = new Map<string, Aggregate>();
    const params: { name: string; sort: Sort }[] = [];
    const jsParams: JsParam[] = [];
    const jsNames = new Set(fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : '')));
    const flat = (owner: ts.Node, base: string, part: string) => {
      const flatName = `${base}${FLAT_SEPARATOR}${part}`;

      if (jsNames.has(flatName) || params.some((q) => q.name === flatName))
        throw new Unsupported(
          owner,
          'parameter',
          `parameter name ${flatName} collides with a flattened field`,
        );

      return flatName;
    };

    for (const p of fn.parameters) {
      if (!ts.isIdentifier(p.name))
        throw new Unsupported(p, 'destructuring', 'destructured parameters are not supported');

      if (p.questionToken || p.initializer || p.dotDotDotToken) {
        throw new Unsupported(p, 'parameter', 'optional, default and rest parameters can be undefined');
      }
      const pname = p.name.text;
      const shape = shapeOfType(p.type, `parameter ${pname}`, p, sf);

      if (shape.kind === 'scalar') {
        paramSorts.set(pname, shape.sort);
        vars.set(pname, { kind: 'var', name: pname });
        params.push({ name: pname, sort: shape.sort });
        jsParams.push({ kind: 'scalar', name: pname, param: pname });
      } else if (shape.kind === 'record') {
        const fields = new Map<string, { param: string; sort: Sort }>();

        for (const f of shape.fields) {
          const param = flat(p, pname, f.key);
          fields.set(f.key, { param, sort: f.sort });
          paramSorts.set(param, f.sort);
          params.push({ name: param, sort: f.sort });
        }
        aggregates.set(pname, { kind: 'record', name: pname, fields });
        jsParams.push({
          kind: 'record',
          name: pname,
          fields: [...fields].map(([key, f]) => ({ key, param: f.param })),
        });
      } else {
        const length = flat(p, pname, 'length');
        const elements = Array.from({ length: maxArrayLength }, (_, i) => flat(p, pname, String(i)));
        params.push({ name: length, sort: 'int' });
        paramSorts.set(length, 'int');

        for (const e of elements) {
          params.push({ name: e, sort: shape.sort });
          paramSorts.set(e, shape.sort);
        }
        lengths.add(length);
        aggregates.set(pname, { kind: 'array', name: pname, length, elements, sort: shape.sort });
        jsParams.push({ kind: 'array', name: pname, length, elements });
      }
    }
    const returns = sortOfType(fn.type, `return type of ${name}`, fn);
    const outOfBounds: Expr[] = [];
    const scope: Scope = {
      sf,
      vars,
      paramSorts,
      functions: models,
      // Callees are namespaced per root model so an original and a mutant can coexist in one query.
      translateCallee: (callee) => translateNamed(callee, `${rootModel}__${callee}`),
      aggregates,
      path: [],
      outOfBounds,
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
      ...(jsParams.some((p) => p.kind !== 'scalar') ? { jsParams } : {}),
      ...(outOfBounds.length ? { outOfBounds } : {}),
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
    p.sort === 'bool'
      ? { name: p.name, sort: 'bool' }
      : {
          name: p.name,
          sort: 'int',
          domain: lengths.has(p.name) ? { min: '0', max: String(maxArrayLength) } : options.domain,
        },
  );
  const dependencies = [...models.values()].filter((m) => m !== model);

  return { status: 'translated', model, params, dependencies };
}
