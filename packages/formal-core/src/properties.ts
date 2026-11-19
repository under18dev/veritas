import type { Expr, FunctionModel, IntDomain, Param, PropertyIR } from '@under18dev/veritas-core';

type Translated = { model: FunctionModel; params: Param[]; dependencies: FunctionModel[] };
type Comparison = '<' | '<=' | '>' | '>=' | '==';

const v = (name: string): Expr => ({ kind: 'var', name });
const lit = (value: string | boolean): Expr =>
  typeof value === 'boolean' ? { kind: 'bool', value } : { kind: 'int', value };

function callOf(t: Translated): Expr {
  return { kind: 'call', fn: t.model.name, args: t.params.map((p) => v(p.name)) };
}

function withDomain(params: Param[], domain?: IntDomain): Param[] {
  return params.map((p) => (p.sort === 'int' && domain ? { ...p, domain } : p));
}

/**
 * Threshold property from a normative statement such as "total >= 1000 receives 100":
 * forall inputs: (param op value) => impl(...) == whenTrue, and, if given, not(param op value) => impl(...) == whenFalse.
 */
export function thresholdProperty(options: {
  implementation: Translated;
  param: string;
  operator: Comparison;
  value: string;
  whenTrue: string | boolean;
  whenFalse?: string | boolean;
  domain?: IntDomain;
}): PropertyIR {
  const { implementation: impl } = options;
  if (!impl.params.some((p) => p.name === options.param && p.sort === 'int')) {
    throw new Error(`${options.param} is not an integer parameter of ${impl.model.name}`);
  }
  const cond: Expr = {
    kind: 'binary',
    op: options.operator,
    left: v(options.param),
    right: lit(options.value),
  };
  const result = callOf(impl);
  const positive: Expr = {
    kind: 'binary',
    op: 'implies',
    left: cond,
    right: { kind: 'binary', op: '==', left: result, right: lit(options.whenTrue) },
  };
  const body: Expr =
    options.whenFalse === undefined
      ? positive
      : {
          kind: 'binary',
          op: 'and',
          left: positive,
          right: {
            kind: 'binary',
            op: 'implies',
            left: { kind: 'unary', op: 'not', arg: cond },
            right: { kind: 'binary', op: '==', left: result, right: lit(options.whenFalse) },
          },
        };
  return {
    irVersion: 1,
    params: withDomain(impl.params, options.domain),
    preconditions: [],
    functions: [...impl.dependencies, impl.model],
    body,
  };
}

/** Bounded equivalence of two models with the same signature (e.g. original and mutant): forall x: a(x) == b(x). */
export function equivalenceProperty(a: Translated, b: Translated, domain?: IntDomain): PropertyIR {
  if (
    a.params.length !== b.params.length ||
    a.params.some((p, i) => p.sort !== b.params[i]?.sort) ||
    a.model.returns !== b.model.returns
  ) {
    throw new Error(`${a.model.name} and ${b.model.name} have different signatures`);
  }
  const call = (t: Translated): Expr => ({
    kind: 'call',
    fn: t.model.name,
    args: a.params.map((p) => v(p.name)),
  });
  return {
    irVersion: 1,
    params: withDomain(a.params, domain),
    preconditions: [],
    functions: [...a.dependencies, a.model, ...b.dependencies, b.model],
    body: { kind: 'binary', op: '==', left: call(a), right: call(b) },
  };
}

/** Apply a source-level mutation at a 1-based line/column, verifying the original text is there. */
export function applyMutation(
  source: string,
  mutation: { line: number; column: number; original: string; replacement: string },
): string {
  const lines = source.split('\n');
  let offset = 0;
  for (let i = 0; i < mutation.line - 1; i++) offset += (lines[i]?.length ?? 0) + 1;
  offset += mutation.column - 1;
  if (source.slice(offset, offset + mutation.original.length) !== mutation.original) {
    throw new Error(`original text not found at ${mutation.line}:${mutation.column}`);
  }
  return source.slice(0, offset) + mutation.replacement + source.slice(offset + mutation.original.length);
}
