import { z } from 'zod';
import { Id, Location } from './common.js';
import { TestOutcome } from './status.js';

export const TestCase = z.object({
  id: Id,
  file: z.string(),
  name: z.string(),
  suitePath: z.array(z.string()),
  location: Location,
  modifiers: z.array(z.enum(['skip', 'only', 'todo', 'concurrent', 'each'])),
  assertionCount: z.number().int().nonnegative(),
  calledSymbols: z.array(z.string()),
  /** Calls to project symbols with their literal arguments (null when not a literal), used for boundary coverage. */
  targetCalls: z.array(
    z.object({
      symbol: z.string(),
      args: z.array(z.string().nullable()),
      asserted: z.boolean(),
      location: Location,
    }),
  ),
  usesMocks: z.boolean(),
  usesSnapshots: z.boolean(),
  nondeterminism: z.array(z.string()),
  /**
   * `unresolved_import`: a call goes through a relative import TypeScript could not resolve.
   * `opaque_call`: the test runs code in a child process or through a dynamic import, or renders JSX with a JSX
   * runtime of the project (an `@jsxImportSource` pragma with a relative path).
   * Either way, what the test reaches is unknown rather than absent.
   * `type_level_only`: every assertion checks TypeScript types (`expectTypeOf`, `assertType`), which no run evaluates.
   * `progress_only`: the test awaits a project call and asserts only on constants it records after the await, so it
   * checks that the call settles (does not block), not what the call returns; the link to the result is unknown.
   * `caller_supplied`: the test is registered inside a function (a shared or parameterized suite) and calls values
   * that function's caller supplies, so what it calls is decided at a call site static analysis does not follow.
   */
  suspicions: z.array(
    z.enum([
      'no_assertion',
      'tautological_assertion',
      'target_not_called',
      'unconditional_mock',
      'unresolved_import',
      'opaque_call',
      'type_level_only',
      'progress_only',
      'caller_supplied',
    ]),
  ),
  granularity: z.enum(['test', 'suite']),
});
export type TestCase = z.infer<typeof TestCase>;

/** Name similarity or an LLM guess alone never makes a test count as testing a property. */
export const EdgeEvidenceKind = z.enum([
  'direct_assertion',
  'mutation_evidence',
  'execution_trace',
  'static_call',
  'llm_hypothesis',
  'name_similarity',
]);
export type EdgeEvidenceKind = z.infer<typeof EdgeEvidenceKind>;

export const TestPropertyEdge = z.object({
  id: Id,
  testId: Id,
  symbol: z.string(),
  propertyId: Id.nullable(),
  evidence: z.array(z.object({ kind: EdgeEvidenceKind, detail: z.string(), artifactIds: z.array(Id) })),
});
export type TestPropertyEdge = z.infer<typeof TestPropertyEdge>;

/** The evidence vector behind an assessment. Deliberately not reduced to one score. */
export const EvidenceVector = z.object({
  specificationRelevance: z.array(z.object({ propertyId: Id, status: z.string() })),
  assertionRelevance: z.enum(['checks_result', 'weak', 'none', 'unknown']),
  mutationDetection: z.object({ killed: z.array(Id), survived: z.array(Id), other: z.array(Id) }),
  boundaryCoverage: z.array(z.object({ boundary: z.string(), exercised: z.enum(['yes', 'no', 'unknown']) })),
  formalEvidence: z.array(Id),
  sourceConfidence: z.array(z.string()),
  unknowns: z.array(z.string()),
});
export type EvidenceVector = z.infer<typeof EvidenceVector>;

export const TestAssessment = z.object({
  testId: Id,
  propertyIds: z.array(Id),
  evidenceIds: z.array(Id),
  killedMutantIds: z.array(Id),
  survivedMutantIds: z.array(Id),
  formalClaimIds: z.array(Id),
  vector: EvidenceVector,
  outcome: TestOutcome,
  limitations: z.array(z.string()),
  rationale: z.array(z.string()).min(1),
});
export type TestAssessment = z.infer<typeof TestAssessment>;
