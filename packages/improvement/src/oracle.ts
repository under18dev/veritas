import type { Expr, PropertyIR } from '@veritas/core';
import { evaluate, type IRValue } from '@veritas/formal-core';
import type { ScalarValue } from './schema.js';

/**
 * One documented clause of a property: `guard => model(params...) == documented`. `guard` and `documented`
 * never mention a function, so evaluating them never consults the implementation model.
 */
export interface SpecClause {
  guard: Expr | null;
  documented: Expr;
  /** Model function the clause constrains. */
  fn: string;
}

export type Expectation =
  | { status: 'expected'; value: ScalarValue; clause: SpecClause }
  | { status: 'none'; reason: string };

function mentionsCall(expr: Expr): boolean {
  switch (expr.kind) {
    case 'call':
      return true;
    case 'unary':
      return mentionsCall(expr.arg);
    case 'binary':
      return mentionsCall(expr.left) || mentionsCall(expr.right);
    case 'ite':
      return mentionsCall(expr.cond) || mentionsCall(expr.whenTrue) || mentionsCall(expr.whenFalse);
    default:
      return false;
  }
}

/** `call(fn, params in order) == spec` (either side). */
function asConstraint(expr: Expr, params: string[]): { fn: string; documented: Expr } | null {
  if (expr.kind !== 'binary' || expr.op !== '==') return null;
  for (const [call, other] of [
    [expr.left, expr.right],
    [expr.right, expr.left],
  ] as const) {
    if (
      call.kind === 'call' &&
      call.args.length === params.length &&
      call.args.every((a, i) => a.kind === 'var' && a.name === params[i]) &&
      !mentionsCall(other)
    ) {
      return { fn: call.fn, documented: other };
    }
  }
  return null;
}

/**
 * Split a property body into documented clauses. Bodies that are not conjunctions of
 * `guard => f(params) == value` (e.g. equivalence of two models) yield no clause: they document no value.
 */
export function specClauses(ir: PropertyIR): SpecClause[] {
  const params = ir.params.map((p) => p.name);
  const out: SpecClause[] = [];
  const visit = (expr: Expr): boolean => {
    if (expr.kind === 'binary' && expr.op === 'and') return visit(expr.left) && visit(expr.right);
    if (expr.kind === 'binary' && expr.op === 'implies' && !mentionsCall(expr.left)) {
      const c = asConstraint(expr.right, params);
      if (!c) return false;
      out.push({ guard: expr.left, ...c });
      return true;
    }
    const c = asConstraint(expr, params);
    if (!c) return false;
    out.push({ guard: null, ...c });
    return true;
  };
  return visit(ir.body) ? out : [];
}

function toIR(value: ScalarValue): IRValue {
  return typeof value === 'boolean' ? value : BigInt(value);
}

function fromIR(value: IRValue): ScalarValue {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * The value the specification model documents for `input`, computed only from the property's guards and
 * documented values with the IR interpreter. The implementation model in the IR is never evaluated.
 */
export function expectedFromSpec(
  ir: PropertyIR,
  input: Record<string, ScalarValue>,
  options: { exclude?: (clause: SpecClause) => boolean } = {},
): Expectation {
  const env = new Map<string, IRValue>();
  for (const p of ir.params) {
    const v = input[p.name];
    if (v === undefined) return { status: 'none', reason: `no value for parameter ${p.name}` };
    if (p.sort === 'int') {
      if (typeof v !== 'string') return { status: 'none', reason: `${p.name} must be an integer` };
      const n = BigInt(v);
      if (n < BigInt(p.domain.min) || n > BigInt(p.domain.max)) {
        return { status: 'none', reason: `${p.name}=${v} is outside the model domain` };
      }
      if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER)) {
        return { status: 'none', reason: `${p.name}=${v} is not a safe integer` };
      }
    } else if (typeof v !== 'boolean') {
      return { status: 'none', reason: `${p.name} must be a boolean` };
    }
    env.set(p.name, toIR(v));
  }
  const noFunctions = new Map();
  try {
    for (const pre of ir.preconditions) {
      if (mentionsCall(pre)) return { status: 'none', reason: 'a precondition refers to a function model' };
      if (evaluate(pre, env, noFunctions) !== true)
        return { status: 'none', reason: 'precondition is false' };
    }
    const clauses = specClauses(ir);
    if (clauses.length === 0) return { status: 'none', reason: 'the property documents no concrete value' };
    const applicable: { value: ScalarValue; clause: SpecClause }[] = [];
    let excluded = 0;
    for (const clause of clauses) {
      if (clause.guard && evaluate(clause.guard, env, noFunctions) !== true) continue;
      if (options.exclude?.(clause)) {
        excluded++;
        continue;
      }
      applicable.push({ value: fromIR(evaluate(clause.documented, env, noFunctions)), clause });
    }
    const first = applicable[0];
    if (!first) {
      return {
        status: 'none',
        reason:
          excluded > 0
            ? 'the value for this input is only an assumption of the formal model, not stated by the source'
            : 'no documented clause applies to this input',
      };
    }
    if (applicable.some((a) => a.value !== first.value)) {
      return { status: 'none', reason: 'documented clauses disagree for this input' };
    }
    return { status: 'expected', value: first.value, clause: first.clause };
  } catch (error) {
    return { status: 'none', reason: `cannot evaluate the specification: ${(error as Error).message}` };
  }
}
