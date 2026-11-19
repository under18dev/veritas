import { CodeIndex } from '@under18dev/veritas-code-intelligence';
import { Finding, FormalClaim, Mutant, Property, Run, TestAssessment } from '@under18dev/veritas-core';
import { MutationRunResult } from '@under18dev/veritas-mutation-adapter';
import { PbtResult } from '@under18dev/veritas-property-testing';
import { DiscoveryResult } from '@under18dev/veritas-spec-discovery';
import { TestInventory } from '@under18dev/veritas-test-inventory';
import { z } from 'zod';

/** File names and schemas of every artifact a run can contain. Stages and entry points share this table. */
export const ARTIFACTS = {
  run: { file: 'run.json', schema: Run },
  evidence: { file: 'evidence.json', schema: DiscoveryResult },
  codeIndex: { file: 'code-index.json', schema: CodeIndex },
  properties: {
    file: 'properties.json',
    schema: z.object({
      properties: z.array(Property),
      conflicts: z.array(
        z.object({
          id: z.string(),
          symbol: z.string(),
          param: z.string(),
          propertyIds: z.array(z.string()),
          preferredPropertyId: z.string().nullable(),
          rationale: z.array(z.string()),
        }),
      ),
      mapping: z.array(
        z.object({
          statementId: z.string(),
          status: z.enum(['mapped', 'unmapped', 'not_threshold', 'stale', 'duplicate']),
          symbol: z.string().nullable(),
          reason: z.string(),
        }),
      ),
      formalization: z.array(
        z.object({
          propertyId: z.string(),
          status: z.enum(['formalized', 'not_formalizable']),
          detail: z.string(),
        }),
      ),
      staleApprovals: z.array(z.string()),
    }),
  },
  testMap: { file: 'test-map.json', schema: TestInventory },
  mutation: {
    file: 'mutation.json',
    schema: MutationRunResult.omit({ mutants: true }).extend({ mutants: z.array(Mutant) }),
  },
  claims: { file: 'claims.json', schema: z.array(FormalClaim) },
  pbt: { file: 'pbt.json', schema: z.array(PbtResult) },
  assessments: { file: 'assessments.json', schema: z.array(TestAssessment) },
  findings: { file: 'findings.json', schema: z.array(Finding) },
} as const;

export type ArtifactName = keyof typeof ARTIFACTS;
export type ArtifactData<N extends ArtifactName> = z.output<(typeof ARTIFACTS)[N]['schema']>;
