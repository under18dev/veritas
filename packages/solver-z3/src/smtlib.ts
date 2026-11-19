import { type Expr, type FunctionModel, type PropertyIR, type Sort, VeritasError } from '@veritas/core';

export const SAFE_MAX = 9007199254740991n;
export const SAFE_MIN = -9007199254740991n;

const NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function symbol(name: string): string {
  if (!NAME.test(name))
    throw new VeritasError('user', 'IR_INVALID_NAME', `invalid identifier in property IR: ${name}`);
  return `|${name}|`;
}

function intLiteral(value: string | bigint): string {
  const v = BigInt(value);
  return v < 0n ? `(- ${-v})` : `${v}`;
}

const SMT_OP: Record<string, string> = {
  '+': '+',
  '-': '-',
  '*': '*',
  div: 'div',
  mod: 'mod',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
  '==': '=',
  and: 'and',
  or: 'or',
  implies: '=>',
};

type Env = Map<string, Sort>;

/** Infer the sort of an expression, rejecting ill-sorted IR instead of letting the solver guess. */
export function sortOf(expr: Expr, env: Env, functions: Map<string, FunctionModel>): Sort {
  const fail = (message: string): never => {
    throw new VeritasError('user', 'IR_ILL_SORTED', message);
  };
  switch (expr.kind) {
    case 'var': {
      const s = env.get(expr.name);
      return s ?? fail(`unbound variable ${expr.name}`);
    }
    case 'int':
      return 'int';
    case 'bool':
      return 'bool';
    case 'unary': {
      const s = sortOf(expr.arg, env, functions);
      if (expr.op === 'not' && s !== 'bool') fail('`not` expects bool');
      if (expr.op === 'neg' && s !== 'int') fail('`neg` expects int');
      return s;
    }
    case 'binary': {
      const l = sortOf(expr.left, env, functions);
      const r = sortOf(expr.right, env, functions);
      if (['+', '-', '*', 'div', 'mod'].includes(expr.op)) {
        if (l !== 'int' || r !== 'int') fail(`${expr.op} expects int operands`);
        return 'int';
      }
      if (['<', '<=', '>', '>='].includes(expr.op)) {
        if (l !== 'int' || r !== 'int') fail(`${expr.op} expects int operands`);
        return 'bool';
      }
      if (expr.op === '==' || expr.op === '!=') {
        if (l !== r) fail(`${expr.op} compares ${l} with ${r}`);
        return 'bool';
      }
      if (l !== 'bool' || r !== 'bool') fail(`${expr.op} expects bool operands`);
      return 'bool';
    }
    case 'ite': {
      if (sortOf(expr.cond, env, functions) !== 'bool') fail('ite condition must be bool');
      const a = sortOf(expr.whenTrue, env, functions);
      const b = sortOf(expr.whenFalse, env, functions);
      if (a !== b) fail('ite branches have different sorts');
      return a;
    }
    case 'call': {
      const fn = functions.get(expr.fn) ?? fail(`unknown function ${expr.fn}`);
      if (fn.params.length !== expr.args.length) fail(`${expr.fn} expects ${fn.params.length} arguments`);
      expr.args.forEach((arg, i) => {
        if (sortOf(arg, env, functions) !== fn.params[i]?.sort)
          fail(`argument ${i + 1} of ${expr.fn} has the wrong sort`);
      });
      return fn.returns;
    }
  }
}

export function emitExpr(expr: Expr): string {
  switch (expr.kind) {
    case 'var':
      return symbol(expr.name);
    case 'int':
      return intLiteral(expr.value);
    case 'bool':
      return expr.value ? 'true' : 'false';
    case 'unary':
      return expr.op === 'not' ? `(not ${emitExpr(expr.arg)})` : `(- ${emitExpr(expr.arg)})`;
    case 'binary':
      if (expr.op === '!=') return `(not (= ${emitExpr(expr.left)} ${emitExpr(expr.right)}))`;
      return `(${SMT_OP[expr.op]} ${emitExpr(expr.left)} ${emitExpr(expr.right)})`;
    case 'ite':
      return `(ite ${emitExpr(expr.cond)} ${emitExpr(expr.whenTrue)} ${emitExpr(expr.whenFalse)})`;
    case 'call':
      return expr.args.length === 0
        ? symbol(expr.fn)
        : `(${symbol(expr.fn)} ${expr.args.map(emitExpr).join(' ')})`;
  }
}

const SMT_SORT: Record<Sort, string> = { int: 'Int', bool: 'Bool' };

/** Functions in dependency order; recursion is outside the supported subset. */
function orderFunctions(functions: FunctionModel[]): FunctionModel[] {
  const byName = new Map(functions.map((f) => [f.name, f]));
  const ordered: FunctionModel[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (f: FunctionModel) => {
    if (state.get(f.name) === 'done') return;
    if (state.get(f.name) === 'visiting') {
      throw new VeritasError('user', 'IR_RECURSIVE', `recursive function ${f.name} is not supported`);
    }
    state.set(f.name, 'visiting');
    const walk = (e: Expr): void => {
      if (e.kind === 'call') {
        const callee = byName.get(e.fn);
        if (callee) visit(callee);
        e.args.forEach(walk);
      } else if (e.kind === 'unary') walk(e.arg);
      else if (e.kind === 'binary') {
        walk(e.left);
        walk(e.right);
      } else if (e.kind === 'ite') {
        walk(e.cond);
        walk(e.whenTrue);
        walk(e.whenFalse);
      }
    };
    if (f.body) walk(f.body);
    state.set(f.name, 'done');
    ordered.push(f);
  };
  functions.forEach(visit);
  return ordered;
}

/** Validate an IR document: names, sorts, domains inside the safe-integer range, no recursion. */
export function checkIR(ir: PropertyIR): void {
  const functions = new Map<string, FunctionModel>();
  for (const f of ir.functions) {
    symbol(f.name);
    if (functions.has(f.name)) throw new VeritasError('user', 'IR_DUPLICATE', `duplicate function ${f.name}`);
    functions.set(f.name, f);
  }
  orderFunctions(ir.functions);
  for (const f of ir.functions) {
    if (!f.body) continue;
    const env: Env = new Map(f.params.map((p) => [p.name, p.sort]));
    if (sortOf(f.body, env, functions) !== f.returns) {
      throw new VeritasError('user', 'IR_ILL_SORTED', `body of ${f.name} does not return ${f.returns}`);
    }
  }
  const env: Env = new Map();
  for (const p of ir.params) {
    symbol(p.name);
    if (env.has(p.name)) throw new VeritasError('user', 'IR_DUPLICATE', `duplicate parameter ${p.name}`);
    env.set(p.name, p.sort);
    if (p.sort === 'int' && (BigInt(p.domain.min) < SAFE_MIN || BigInt(p.domain.max) > SAFE_MAX)) {
      throw new VeritasError(
        'user',
        'IR_DOMAIN_UNSAFE',
        `domain of ${p.name} exceeds the safe-integer range`,
      );
    }
  }
  for (const pre of ir.preconditions) {
    if (sortOf(pre, env, functions) !== 'bool')
      throw new VeritasError('user', 'IR_ILL_SORTED', 'precondition must be bool');
  }
  if (sortOf(ir.body, env, functions) !== 'bool')
    throw new VeritasError('user', 'IR_ILL_SORTED', 'property body must be bool');
}

function preamble(ir: PropertyIR, timeoutMs: number): string[] {
  const lines = [
    '(set-logic ALL)',
    `(set-option :timeout ${timeoutMs})`,
    '(set-option :produce-models true)',
  ];
  for (const f of orderFunctions(ir.functions)) {
    const params = f.params.map((p) => `(${symbol(p.name)} ${SMT_SORT[p.sort]})`).join(' ');
    if (f.body)
      lines.push(`(define-fun ${symbol(f.name)} (${params}) ${SMT_SORT[f.returns]} ${emitExpr(f.body)})`);
    else
      lines.push(
        `(declare-fun ${symbol(f.name)} (${f.params.map((p) => SMT_SORT[p.sort]).join(' ')}) ${SMT_SORT[f.returns]})`,
      );
  }
  for (const p of ir.params) {
    lines.push(`(declare-const ${symbol(p.name)} ${SMT_SORT[p.sort]})`);
    if (p.sort === 'int') {
      lines.push(`(assert (<= ${intLiteral(p.domain.min)} ${symbol(p.name)} ${intLiteral(p.domain.max)}))`);
    }
  }
  for (const pre of ir.preconditions) lines.push(`(assert ${emitExpr(pre)})`);
  return lines;
}

function epilogue(ir: PropertyIR): string[] {
  const out = ['(check-sat)'];
  if (ir.params.length > 0) out.push(`(get-value (${ir.params.map((p) => symbol(p.name)).join(' ')}))`);
  out.push('(get-info :reason-unknown)');
  return out;
}

/**
 * Query for "forall params in their domains: preconditions => body".
 * `unsat` means no counterexample exists in the model; `sat` yields one.
 */
export function conformanceQuery(ir: PropertyIR, timeoutMs: number): string {
  checkIR(ir);
  return [
    '; veritas conformance query: is there an input in the domain that violates the property?',
    ...preamble(ir, timeoutMs),
    `(assert (not ${emitExpr(ir.body)}))`,
    ...epilogue(ir),
    '',
  ].join('\n');
}

/** Replace calls with function bodies so every arithmetic term is expressed over the property parameters. */
function inline(
  expr: Expr,
  functions: Map<string, FunctionModel>,
  subst: Map<string, Expr> = new Map(),
): Expr {
  switch (expr.kind) {
    case 'var':
      return subst.get(expr.name) ?? expr;
    case 'int':
    case 'bool':
      return expr;
    case 'unary':
      return { ...expr, arg: inline(expr.arg, functions, subst) };
    case 'binary':
      return {
        ...expr,
        left: inline(expr.left, functions, subst),
        right: inline(expr.right, functions, subst),
      };
    case 'ite':
      return {
        ...expr,
        cond: inline(expr.cond, functions, subst),
        whenTrue: inline(expr.whenTrue, functions, subst),
        whenFalse: inline(expr.whenFalse, functions, subst),
      };
    case 'call': {
      const fn = functions.get(expr.fn);
      const args = expr.args.map((a) => inline(a, functions, subst));
      if (!fn?.body) return { ...expr, args };
      const inner = new Map(fn.params.map((p, i) => [p.name, args[i] as Expr]));
      return inline(fn.body, functions, inner);
    }
  }
}

function arithmeticTerms(expr: Expr, out: Expr[] = []): Expr[] {
  if (expr.kind === 'binary') {
    if (['+', '-', '*'].includes(expr.op)) out.push(expr);
    arithmeticTerms(expr.left, out);
    arithmeticTerms(expr.right, out);
  } else if (expr.kind === 'unary') {
    if (expr.op === 'neg') out.push(expr);
    arithmeticTerms(expr.arg, out);
  } else if (expr.kind === 'ite') {
    arithmeticTerms(expr.cond, out);
    arithmeticTerms(expr.whenTrue, out);
    arithmeticTerms(expr.whenFalse, out);
  } else if (expr.kind === 'call') {
    for (const a of expr.args) arithmeticTerms(a, out);
  }
  return out;
}

/**
 * Query for the JS-number obligation: can any intermediate integer leave the safe-integer range for an
 * input in the domain? `unsat` means integer arithmetic and JS doubles agree on every reachable input.
 * Returns null when the property has no arithmetic.
 */
export function safeRangeQuery(ir: PropertyIR, timeoutMs: number): string | null {
  checkIR(ir);
  const functions = new Map(ir.functions.map((f) => [f.name, f]));
  const terms = arithmeticTerms(inline(ir.body, functions));
  for (const pre of ir.preconditions) terms.push(...arithmeticTerms(inline(pre, functions)));
  if (terms.length === 0) return null;
  const outOfRange = terms.map((t) => {
    const e = emitExpr(t);
    return `(or (< ${e} ${intLiteral(SAFE_MIN)}) (> ${e} ${intLiteral(SAFE_MAX)}))`;
  });
  return [
    '; veritas safe-integer obligation: can an intermediate value leave the JS safe-integer range?',
    ...preamble(ir, timeoutMs),
    `(assert (or ${outOfRange.join(' ')}))`,
    ...epilogue(ir),
    '',
  ].join('\n');
}
