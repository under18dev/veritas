import type { Expr, FunctionModel } from '@under18dev/veritas-core';

export type IRValue = bigint | boolean;

/** Reference interpreter for the IR with mathematical integers (BigInt), mirroring the SMT semantics. */
export function evaluate(
  expr: Expr,
  env: Map<string, IRValue>,
  functions: Map<string, FunctionModel>,
): IRValue {
  switch (expr.kind) {
    case 'var': {
      const v = env.get(expr.name);
      if (v === undefined) throw new Error(`unbound ${expr.name}`);
      return v;
    }
    case 'int':
      return BigInt(expr.value);
    case 'bool':
      return expr.value;
    case 'unary': {
      const v = evaluate(expr.arg, env, functions);
      return expr.op === 'not' ? !v : -(v as bigint);
    }
    case 'binary': {
      if (expr.op === 'and')
        return Boolean(evaluate(expr.left, env, functions)) && Boolean(evaluate(expr.right, env, functions));
      if (expr.op === 'or')
        return Boolean(evaluate(expr.left, env, functions)) || Boolean(evaluate(expr.right, env, functions));
      if (expr.op === 'implies')
        return !evaluate(expr.left, env, functions) || Boolean(evaluate(expr.right, env, functions));
      const l = evaluate(expr.left, env, functions);
      const r = evaluate(expr.right, env, functions);
      switch (expr.op) {
        case '+':
          return (l as bigint) + (r as bigint);
        case '-':
          return (l as bigint) - (r as bigint);
        case '*':
          return (l as bigint) * (r as bigint);
        case 'div': {
          // SMT-LIB Euclidean division.
          const a = l as bigint;
          const b = r as bigint;
          if (b === 0n) throw new Error('division by zero is unspecified in SMT-LIB');
          const q = a / b;
          return a - q * b < 0n ? (b > 0n ? q - 1n : q + 1n) : q;
        }
        case 'mod': {
          const a = l as bigint;
          const b = r as bigint;
          if (b === 0n) throw new Error('modulo by zero is unspecified in SMT-LIB');
          const m = a % b;
          return m < 0n ? m + (b < 0n ? -b : b) : m;
        }
        case '<':
          return (l as bigint) < (r as bigint);
        case '<=':
          return (l as bigint) <= (r as bigint);
        case '>':
          return (l as bigint) > (r as bigint);
        case '>=':
          return (l as bigint) >= (r as bigint);
        case '==':
          return l === r;
        case '!=':
          return l !== r;
      }
      throw new Error(`unknown operator ${expr.op}`);
    }
    case 'ite':
      return evaluate(expr.cond, env, functions)
        ? evaluate(expr.whenTrue, env, functions)
        : evaluate(expr.whenFalse, env, functions);
    case 'call': {
      const fn = functions.get(expr.fn);
      if (!fn?.body) throw new Error(`opaque function ${expr.fn} cannot be evaluated`);
      const args = expr.args.map((a) => evaluate(a, env, functions));
      return evaluate(fn.body, new Map(fn.params.map((p, i) => [p.name, args[i] as IRValue])), functions);
    }
  }
}

export function callModel(model: FunctionModel, args: IRValue[], functions: FunctionModel[]): IRValue {
  const table = new Map(functions.map((f) => [f.name, f]));
  table.set(model.name, model);
  return evaluate({ kind: 'call', fn: model.name, args: args.map(toLiteral) }, new Map(), table);
}

export function toLiteral(v: IRValue): Expr {
  return typeof v === 'bigint' ? { kind: 'int', value: v.toString() } : { kind: 'bool', value: v };
}

/**
 * Rebuild the JavaScript arguments of `model` from its flattened parameter values: records become objects,
 * arrays become arrays of their modelled length (slots at or beyond it are dropped). Leaves are passed through
 * `leaf`; `length` reads an array length value. Models without `jsParams` take their parameters in order.
 */
export function shapeArguments<T, L>(
  model: FunctionModel,
  values: Map<string, T>,
  leaf: (value: T) => L,
  length: (value: T) => number,
): (L | Record<string, L> | L[])[] {
  const get = (name: string): T => {
    if (!values.has(name)) throw new Error(`no value for ${name}`);
    return values.get(name) as T;
  };
  if (!model.jsParams) return model.params.map((p) => leaf(get(p.name)));
  return model.jsParams.map((p) => {
    if (p.kind === 'scalar') return leaf(get(p.param));
    if (p.kind === 'record') return Object.fromEntries(p.fields.map((f) => [f.key, leaf(get(f.param))]));
    const n = length(get(p.length));
    if (!Number.isInteger(n) || n < 0 || n > p.elements.length)
      throw new Error(`invalid length ${n} for ${p.name}`);
    return p.elements.slice(0, n).map((e) => leaf(get(e)));
  });
}
