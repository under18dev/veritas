import { z } from 'zod';
import { Id, IsoDate } from './common.js';
import { CapabilityState, StageStatus } from './status.js';

export const CapabilityName = z.enum([
  'node',
  'git',
  'package_manager',
  'typescript',
  'vitest',
  'jest',
  'mutator',
  'fast_check',
  'z3',
  'lean',
  'llm',
  'network',
  'sandbox',
]);
export type CapabilityName = z.infer<typeof CapabilityName>;

export const Capability = z.object({
  name: CapabilityName,
  state: CapabilityState,
  version: z.string().optional(),
  detail: z.string(),
  affects: z.array(z.string()),
});
export type Capability = z.infer<typeof Capability>;

export const StageName = z.enum([
  'index',
  'discover',
  'analyze',
  'spec',
  'map',
  'mutate',
  'pbt',
  'prove',
  'assess',
  'improve',
  'report',
]);
export type StageName = z.infer<typeof StageName>;

export const UsageCounters = z.object({
  llmTokens: z.number().int().nonnegative(),
  solverMs: z.number().nonnegative(),
  mutants: z.number().int().nonnegative(),
  testRuns: z.number().int().nonnegative(),
});
export type UsageCounters = z.infer<typeof UsageCounters>;

export const StageResult = z.object({
  stage: StageName,
  status: StageStatus,
  startedAt: IsoDate,
  finishedAt: IsoDate,
  durationMs: z.number().nonnegative(),
  artifacts: z.array(z.string()),
  messages: z.array(z.string()),
  usage: UsageCounters,
});
export type StageResult = z.infer<typeof StageResult>;

export const Run = z.object({
  id: Id,
  command: z.string(),
  args: z.array(z.string()),
  profile: z.enum(['quick', 'standard', 'deep']).optional(),
  scope: z.object({ root: z.string(), since: z.string().optional(), paths: z.array(z.string()) }),
  /** The options that select what the run verifies, so `veritas replay` can repeat exactly the same run. */
  options: z
    .object({
      includeProposed: z.boolean(),
      propertyIds: z.array(z.string()).optional(),
      formalEngine: z.enum(['z3', 'lean', 'both']).optional(),
      sources: z.array(z.enum(['local', 'github', 'web'])).optional(),
      web: z
        .object({
          allowDomains: z.array(z.string()).optional(),
          maxPages: z.number().int().positive().optional(),
        })
        .optional(),
      mutationReport: z.string().optional(),
      killMatrix: z.boolean().optional(),
      offline: z.boolean(),
    })
    .optional(),
  startedAt: IsoDate,
  finishedAt: IsoDate.optional(),
  status: StageStatus,
  exitCode: z.number().int().min(0).max(4).optional(),
  verdict: z.enum(['pass', 'pass_with_warnings', 'policy_failure', 'tool_error', 'inconclusive']).optional(),
  policyReasons: z.array(z.string()).default([]),
  stages: z.array(StageResult),
  capabilities: z.array(Capability),
  environment: z.object({ os: z.string(), arch: z.string(), node: z.string() }),
  seeds: z.record(z.string(), z.union([z.number(), z.string()])),
  usage: UsageCounters,
  replay: z.string(),
  partial: z.boolean(),
});
export type Run = z.infer<typeof Run>;
