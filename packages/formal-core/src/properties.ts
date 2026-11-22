import type { Expr, FunctionModel, IntDomain, Param, PropertyIR } from '@under18dev/veritas-core';

type Translated = { model: FunctionModel; params: Param[]; dependencies: FunctionModel[] };
type Comparison = '<' | '<=' | '>' | '>=' | '==';

const v = (name: string): Expr => ({ kind: 'var', name });
const lit = (value: string | boolean): Expr =>
  typeof value === 'boolean' ? { kind: 'bool', value } : { kind: 'int', value };

function callOf(t: Translated): Expr {
  return { kind: 'call', fn: t.model.name, args: t.params.map((p) => v(p.name)) };
}

/** Apply the integer domain to every integer parameter except array lengths, which keep [0, maxArrayLength]. */
function withDomain(params: Param[], domain: IntDomain | undefined, model: FunctionModel): Param[] {
  const lengths = new Set((model.jsParams ?? []).flatMap((p) => (p.kind === 'array' ? [p.length] : [])));

  return params.map((p) => (p.sort === 'int' && domain && !lengths.has(p.name) ? { ...p, domain } : p));
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
    params: withDomain(impl.params, options.domain, impl.model),
    preconditions: [],
    functions: [...impl.dependencies, impl.model],
    body,
  };
}

/**
 * A declared `holds_for_all` property: forall inputs within the domain, impl(...) == true. The implementation
 * must return a boolean.
 */
export function holdsForAllProperty(implementation: Translated, domain?: IntDomain): PropertyIR {
  if (implementation.model.returns !== 'bool')
    throw new Error(`${implementation.model.name} does not return a boolean`);

  return {
    irVersion: 1,
    params: withDomain(implementation.params, domain, implementation.model),
    preconditions: [],
    functions: [...implementation.dependencies, implementation.model],
    body: { kind: 'binary', op: '==', left: callOf(implementation), right: lit(true) },
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
    params: withDomain(a.params, domain, a.model),
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

/**
 * Restrict an IR to a finite set of inputs (for example the literal arguments of a test): a precondition that
 * the parameters equal one of `inputs`. Each input must give every parameter a value of its sort.
 */
export function restrictToInputs(ir: PropertyIR, inputs: Record<string, string | boolean>[]): PropertyIR {
  if (inputs.length === 0) throw new Error('at least one input is needed');
  const equalities = inputs.map((input) =>
    ir.params
      .map((p): Expr => {
        const value = input[p.name];

        if (value === undefined || typeof value !== (p.sort === 'bool' ? 'boolean' : 'string'))
          throw new Error(`input does not give ${p.name} a ${p.sort} value`);

        return { kind: 'binary', op: '==', left: v(p.name), right: lit(value) };
      })
      .reduce((a, b): Expr => ({ kind: 'binary', op: 'and', left: a, right: b })),
  );
  const anyInput = equalities.reduce((a, b): Expr => ({ kind: 'binary', op: 'or', left: a, right: b }));

  return { ...ir, preconditions: [...ir.preconditions, anyInput] };
}

/** `expr` with every call to `from` replaced by a call to `to`. */
export function renameCalls(expr: Expr, from: string, to: string): Expr {
  switch (expr.kind) {
    case 'unary':
      return { ...expr, arg: renameCalls(expr.arg, from, to) };
    case 'binary':
      return { ...expr, left: renameCalls(expr.left, from, to), right: renameCalls(expr.right, from, to) };
    case 'ite':
      return {
        ...expr,
        cond: renameCalls(expr.cond, from, to),
        whenTrue: renameCalls(expr.whenTrue, from, to),
        whenFalse: renameCalls(expr.whenFalse, from, to),
      };
    case 'call':
      return {
        ...expr,
        fn: expr.fn === from ? to : expr.fn,
        args: expr.args.map((a) => renameCalls(a, from, to)),
      };
    default:
      return expr;
  }
}

/**
 * Whether a property tells a mutant from the original: forall inputs, property(original) implies
 * property(mutant). A counterexample is an input where the original satisfies the property and the mutant does
 * not, so the property detects that change; where the original already violates it, nothing is credited.
 * `mutant` must have the signature of the model named `original` and a different model name.
 */
export function detectionProperty(ir: PropertyIR, original: string, mutant: Translated): PropertyIR {
  const current = ir.functions.find((f) => f.name === original);
  const m = mutant.model;

  if (
    !current ||
    m.name === original ||
    current.returns !== m.returns ||
    current.params.length !== m.params.length ||
    current.params.some((p, i) => p.sort !== m.params[i]?.sort)
  ) {
    throw new Error(`the mutant of ${original} does not have the signature the property was written for`);
  }

  return {
    ...ir,
    functions: [...ir.functions, ...mutant.dependencies, m],
    body: { kind: 'binary', op: 'implies', left: ir.body, right: renameCalls(ir.body, original, m.name) },
  };
}
