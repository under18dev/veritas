import { toJSONSchema, type z } from 'zod';
import { VeritasConfig } from './config/schema.js';
import { ArtifactMeta } from './schema/common.js';
import { EvidenceSource } from './schema/evidence.js';
import { Finding } from './schema/finding.js';
import { FormalClaim } from './schema/formal.js';
import { ImprovementPlan, PatchAttempt } from './schema/improvement.js';
import { PropertyIR } from './schema/ir.js';
import { Mutant } from './schema/mutation.js';
import { ApprovalLedger, Property } from './schema/property.js';
import { Capability, Run, StageResult } from './schema/run.js';
import { TestAssessment, TestCase, TestPropertyEdge } from './schema/tests.js';

/** Public schemas exported as JSON Schema under `schemas/`. */
export const PUBLIC_SCHEMAS: Record<string, z.ZodType> = {
  config: VeritasConfig,
  'artifact-meta': ArtifactMeta,
  'evidence-source': EvidenceSource,
  property: Property,
  'property-ir': PropertyIR,
  'approval-ledger': ApprovalLedger,
  'formal-claim': FormalClaim,
  mutant: Mutant,
  'test-case': TestCase,
  'test-property-edge': TestPropertyEdge,
  'test-assessment': TestAssessment,
  finding: Finding,
  'improvement-plan': ImprovementPlan,
  'patch-attempt': PatchAttempt,
  capability: Capability,
  'stage-result': StageResult,
  run: Run,
};

/** JSON Schema documents for every public schema, describing accepted input. */
export function exportJsonSchemas(): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [name, schema] of Object.entries(PUBLIC_SCHEMAS)) {
    out[name] = {
      $id: `https://veritas.invalid/schemas/${name}.json`,
      ...toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }),
    };
  }

  return out;
}
