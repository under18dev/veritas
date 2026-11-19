import { Param } from '@under18dev/veritas-core';
import { z } from 'zod';

export const PbtStatus = z.enum(['passed', 'counterexample', 'error', 'timeout', 'cancelled']);
export type PbtStatus = z.infer<typeof PbtStatus>;

/** A passing random run is empirical evidence only; it never yields a proven status. */
export const PbtTrust = z.enum(['empirically_supported', 'falsified', 'unknown']);
export type PbtTrust = z.infer<typeof PbtTrust>;

/** Concrete input: integers as decimal strings, booleans as booleans. */
export const PbtInput = z.record(z.string(), z.union([z.string().regex(/^-?\d+$/), z.boolean()]));
export type PbtInput = z.infer<typeof PbtInput>;

/**
 * Why an input falsified the property:
 * - `property_violated`: every bound function returned a valid value but the property body was false
 * - `non_integer_result` / `non_boolean_result`: a bound JavaScript function returned a value outside its
 *   IR sort (NaN, 1.5, a string, ...); it is never coerced. `-0` is a safe integer and is read as `0`.
 * - `threw`: a bound JavaScript function threw (including permission-model denials)
 * - `model_error`: the IR itself could not be evaluated for this input (status `error`, not a falsification)
 */
export const PbtFailure = z.object({
  reason: z.string().min(1),
  javascript: z.unknown().optional(),
  expected: z.unknown().optional(),
});
export type PbtFailure = z.infer<typeof PbtFailure>;

export const PbtResult = z.object({
  id: z.string().min(1),
  propertyId: z.string().min(1),
  status: PbtStatus,
  trust: PbtTrust,
  seed: z.number().int(),
  numRuns: z.number().int().positive(),
  /** Runs fast-check reports as executed; null when the run did not complete (timeout, cancel, error). */
  runsExecuted: z.number().int().nonnegative().nullable(),
  counterexample: PbtInput.nullable(),
  originalCounterexample: PbtInput.nullable(),
  shrinks: z.number().int().nonnegative(),
  /** fast-check replay path of the shrunk counterexample. */
  path: z.string().nullable(),
  failure: PbtFailure.nullable(),
  domains: z.array(Param),
  experimental: z.boolean(),
  replayCommand: z.string().min(1),
  durationMs: z.number().nonnegative(),
  error: z.string().nullable(),
});
export type PbtResult = z.infer<typeof PbtResult>;
