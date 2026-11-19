import type { Expr, FunctionModel, PropertyIR } from '@under18dev/veritas-core';
import { shapeArguments } from './interpret.js';

/**
 * A flat model input (`{ order__total: '1000', order__vip: true }`) in the shape of the JavaScript arguments of
 * the first function model whose parameters it covers (`{ order: { total: '1000', vip: true } }`). Inputs no
 * model with records or arrays covers are returned unchanged.
 */
export function shapeInput(ir: PropertyIR, input: Record<string, string | boolean>): Record<string, unknown> {
  const model = ir.functions.find((f) => f.jsParams && f.params.every((p) => p.name in input));
  if (!model?.jsParams) return input;
  const values = new Map(Object.entries(input));
  const shaped = shapeArguments(
    model,
    values,
    (v) => v,
    (v) => Number(v),
  );
  const out: Record<string, unknown> = {};
  model.jsParams.forEach((p, i) => {
    out[p.name] = shaped[i];
  });
  const covered = new Set(model.params.map((p) => p.name));
  for (const [k, v] of Object.entries(input)) if (!covered.has(k)) out[k] = v;
  return out;
}

function substitute(expr: Expr, subst: Map<string, Expr>): Expr {
  switch (expr.kind) {
    case 'var':
      return subst.get(expr.name) ?? expr;
    case 'unary':
      return { ...expr, arg: substitute(expr.arg, subst) };
    case 'binary':
      return { ...expr, left: substitute(expr.left, subst), right: substitute(expr.right, subst) };
    case 'ite':
      return {
        ...expr,
        cond: substitute(expr.cond, subst),
        whenTrue: substitute(expr.whenTrue, subst),
        whenFalse: substitute(expr.whenFalse, subst),
      };
    case 'call':
      return { ...expr, args: expr.args.map((a) => substitute(a, subst)) };
    default:
      return expr;
  }
}

/**
 * Out-of-bounds obligation: an IR whose body holds exactly when no call in the property reads an array element
 * at or beyond the array's length. `null` when no called model reads array elements.
 */
export function outOfBoundsProperty(ir: PropertyIR): PropertyIR | null {
  const table = new Map<string, FunctionModel>(ir.functions.map((f) => [f.name, f]));
  const conditions: Expr[] = [];
  const visit = (expr: Expr): void => {
    switch (expr.kind) {
      case 'unary':
        visit(expr.arg);
        return;
      case 'binary':
        visit(expr.left);
        visit(expr.right);
        return;
      case 'ite':
        visit(expr.cond);
        visit(expr.whenTrue);
        visit(expr.whenFalse);
        return;
      case 'call': {
        for (const a of expr.args) visit(a);
        const fn = table.get(expr.fn);
        if (!fn?.outOfBounds?.length) return;
        const subst = new Map(fn.params.map((p, i) => [p.name, expr.args[i] as Expr]));
        for (const c of fn.outOfBounds) conditions.push(substitute(c, subst));
        return;
      }
      default:
        return;
    }
  };
  visit(ir.body);
  for (const pre of ir.preconditions) visit(pre);
  if (conditions.length === 0) return null;
  const any = conditions.reduce((a, b): Expr => ({ kind: 'binary', op: 'or', left: a, right: b }));
  return { ...ir, body: { kind: 'unary', op: 'not', arg: any } };
}
