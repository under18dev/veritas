import { Id, Location, PropertyTemplate, Sha256 } from '@veritas/core';
import { z } from 'zod';

export const ComparisonOperator = z.enum(['<', '<=', '>', '>=', '===', '!==', '==', '!=']);
export type ComparisonOperator = z.infer<typeof ComparisonOperator>;

export const NumericKind = z.enum(['integer_literal', 'float_literal', 'division', 'nan', 'bigint']);
export type NumericKind = z.infer<typeof NumericKind>;

export const Purity = z.enum(['pure', 'impure', 'unknown']);
export type Purity = z.infer<typeof Purity>;

export const FunctionParam = z.object({
  name: z.string(),
  /** Type as printed by the TypeScript checker. */
  type: z.string(),
  optional: z.boolean(),
});
export type FunctionParam = z.infer<typeof FunctionParam>;

export const Comparison = z.object({
  location: Location,
  operator: ComparisonOperator,
  left: z.string(),
  right: z.string(),
  /** The integer literal side in decimal, e.g. `0x10` becomes `16`; null when neither side is one. */
  literal: z.string().nullable(),
  /** The parameter compared, when one side is a bare parameter of this function. */
  param: z.string().nullable(),
});
export type Comparison = z.infer<typeof Comparison>;

export const FunctionInfo = z.object({
  symbol: z.string(),
  name: z.string(),
  file: z.string(),
  exported: z.boolean(),
  location: Location,
  params: z.array(FunctionParam),
  returnType: z.string(),
  jsdoc: z.string().nullable(),
  async: z.boolean(),
  branches: z.array(z.object({ location: Location, condition: z.string() })),
  comparisons: z.array(Comparison),
  returns: z.array(z.object({ location: Location, expression: z.string() })),
  throws: z.array(z.object({ location: Location, expression: z.string() })),
  /** Symbol ids for callees inside the project, callee text otherwise. */
  calls: z.array(z.string()),
  sideEffects: z.array(z.string()),
  /** Constructs outside what static analysis and the formal subset can model. Never silently dropped. */
  unsupported: z.array(z.object({ location: Location, reason: z.string() })),
  purity: Purity,
  numericKinds: z.array(NumericKind),
});
export type FunctionInfo = z.infer<typeof FunctionInfo>;

export const CodeIndex = z.object({
  files: z.array(z.object({ path: z.string(), hash: Sha256 })),
  functions: z.array(FunctionInfo),
  /** Parse problems and skipped inputs; never fatal. */
  diagnostics: z.array(z.object({ file: z.string(), message: z.string() })),
});
export type CodeIndex = z.infer<typeof CodeIndex>;

export const CandidateBasis = z.enum(['name', 'type', 'comment', 'implementation', 'usage']);
export type CandidateBasis = z.infer<typeof CandidateBasis>;

export const BehaviorCandidate = z.object({
  id: Id,
  symbol: z.string(),
  template: PropertyTemplate,
  description: z.string(),
  boundary: z.object({ param: z.string(), operator: ComparisonOperator, value: z.string() }).optional(),
  basis: z.array(CandidateBasis).min(1),
  /** Candidates come from code alone and are never a specification by themselves. */
  origin: z.literal('inferred'),
  notes: z.array(z.string()),
});
export type BehaviorCandidate = z.infer<typeof BehaviorCandidate>;
