import { z } from 'zod';

/**
 * Property IR: a small, solver-neutral expression language for bounded properties.
 * Sorts are deliberately limited to mathematical integers within an explicit domain and booleans.
 * Mapping these to JS semantics is a separate, recorded obligation (see docs/semantics.md).
 */
export const Sort = z.enum(['int', 'bool']);
export type Sort = z.infer<typeof Sort>;

export const BinaryOp = z.enum([
  '+',
  '-',
  '*',
  'div',
  'mod',
  '<',
  '<=',
  '>',
  '>=',
  '==',
  '!=',
  'and',
  'or',
  'implies',
]);
export type BinaryOp = z.infer<typeof BinaryOp>;

export const UnaryOp = z.enum(['not', 'neg']);
export type UnaryOp = z.infer<typeof UnaryOp>;

export type Expr =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'unary'; op: UnaryOp; arg: Expr }
  | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr }
  | { kind: 'ite'; cond: Expr; whenTrue: Expr; whenFalse: Expr }
  | { kind: 'call'; fn: string; args: Expr[] };

/** Integers are encoded as decimal strings so values beyond Number.MAX_SAFE_INTEGER stay exact. */
export const IntLiteral = z.string().regex(/^-?\d+$/);

export const Expr: z.ZodType<Expr> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('var'), name: z.string().min(1) }),
    z.object({ kind: z.literal('int'), value: IntLiteral }),
    z.object({ kind: z.literal('bool'), value: z.boolean() }),
    z.object({ kind: z.literal('unary'), op: UnaryOp, arg: Expr }),
    z.object({ kind: z.literal('binary'), op: BinaryOp, left: Expr, right: Expr }),
    z.object({ kind: z.literal('ite'), cond: Expr, whenTrue: Expr, whenFalse: Expr }),
    z.object({ kind: z.literal('call'), fn: z.string().min(1), args: z.array(Expr) }),
  ]),
);

export const IntDomain = z
  .object({ min: IntLiteral, max: IntLiteral })
  .refine((d) => BigInt(d.min) <= BigInt(d.max), 'domain min must not exceed max');
export type IntDomain = z.infer<typeof IntDomain>;

export const Param = z.discriminatedUnion('sort', [
  z.object({ name: z.string().min(1), sort: z.literal('int'), domain: IntDomain }),
  z.object({ name: z.string().min(1), sort: z.literal('bool') }),
]);
export type Param = z.infer<typeof Param>;

/** A pure function model referenced by `call` expressions. `body` is null when the function is opaque. */
export const FunctionModel = z.object({
  name: z.string().min(1),
  symbol: z.string(),
  params: z.array(z.object({ name: z.string().min(1), sort: Sort })),
  returns: Sort,
  body: Expr.nullable(),
});
export type FunctionModel = z.infer<typeof FunctionModel>;

/** forall params within domains: (all preconditions) implies body. */
export const PropertyIR = z.object({
  irVersion: z.literal(1),
  params: z.array(Param),
  preconditions: z.array(Expr),
  body: Expr,
  functions: z.array(FunctionModel),
});
export type PropertyIR = z.infer<typeof PropertyIR>;
