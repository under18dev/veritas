import { z } from 'zod';
import { IntLiteral } from '../schema/ir.js';

const Domain = z.string().regex(/^[a-z0-9.-]+$/i, 'expected a bare domain name such as docs.example.com');

export const VeritasConfig = z
  .object({
    $schema: z.string().optional(),
    schemaVersion: z
      .literal('1.0.0', {
        error: 'unsupported configuration schema version; this version of Veritas reads 1.0.0',
      })
      .default('1.0.0'),
    project: z
      .object({
        packageManager: z.enum(['pnpm', 'npm', 'yarn', 'bun', 'unknown']).default('unknown'),
        tsconfig: z.string().nullable().default(null),
      })
      .strict()
      .default({ packageManager: 'unknown', tsconfig: null }),
    sources: z
      .object({
        local: z.boolean().default(true),
        github: z
          .object({
            enabled: z.boolean().default(false),
            // Exactly `owner/name`: anything else could point the token-bearing API request elsewhere.
            repo: z
              .string()
              .regex(
                /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/,
                'expected owner/name',
              )
              .optional(),
          })
          .strict()
          .default({ enabled: false }),
        web: z
          .object({
            enabled: z.boolean().default(false),
            allowDomains: z.array(Domain).default([]),
            maxPages: z.number().int().positive().max(1000).default(30),
            maxDepth: z.number().int().nonnegative().max(5).default(1),
            maxChars: z.number().int().positive().default(200_000),
            timeoutMs: z.number().int().positive().default(30_000),
            /** Total time for the whole crawl; pages not fetched by then are reported as skipped. */
            maxDurationMs: z.number().int().positive().default(120_000),
          })
          .strict()
          .default({
            enabled: false,
            allowDomains: [],
            maxPages: 30,
            maxDepth: 1,
            maxChars: 200_000,
            timeoutMs: 30_000,
            maxDurationMs: 120_000,
          }),
        sendFullTextToLlm: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
    analysis: z
      .object({
        include: z.array(z.string()).min(1).default(['src/**/*.{ts,tsx,js,mjs}']),
        exclude: z.array(z.string()).default(['**/*.generated.*', '**/node_modules/**', '**/dist/**']),
        testInclude: z.array(z.string()).default(['**/*.{test,spec}.{ts,tsx,js,mjs}']),
        testFramework: z.literal('vitest').default('vitest'),
        inferSpecsFromCode: z.boolean().default(true),
        requireApprovalForNormativeClaims: z.boolean().default(true),
      })
      .strict()
      .prefault({}),
    mutation: z
      .object({
        backend: z.literal('mizchi').default('mizchi'),
        mode: z.enum(['diff', 'full']).default('diff'),
        timeoutMs: z.number().int().positive().default(120_000),
      })
      .strict()
      .prefault({}),
    pbt: z
      .object({
        numRuns: z.number().int().positive().max(1_000_000).default(1000),
        seed: z.number().int().optional(),
      })
      .strict()
      .prefault({}),
    formal: z
      .object({
        backend: z.enum(['z3', 'lean']).default('z3'),
        integerDomain: z
          .object({ min: IntLiteral, max: IntLiteral })
          .strict()
          .default({ min: '-10000', max: '10000' }),
        maxSolverMs: z.number().int().positive().default(30_000),
        /** Arrays are modelled with a length in [0, maxArrayLength] and one parameter per element slot. */
        maxArrayLength: z.number().int().min(1).max(8).default(3),
        rejectUnsupportedSemantics: z.literal(true).default(true),
      })
      .strict()
      .prefault({}),
    llm: z
      .object({
        provider: z.enum(['none', 'claude', 'claude-code', 'openai', 'codex']).default('none'),
        model: z.string().optional(),
        maxTokensPerRun: z.number().int().nonnegative().default(200_000),
        /** The codex CLI keeps a read-only shell that can read local files; it is only used with this set. */
        allowCodexFileReads: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
    improvement: z
      .object({
        autoApply: z.literal(false).default(false),
        testFilesOnly: z.boolean().default(true),
        maxIterations: z.number().int().positive().max(20).default(3),
        maxPatchFiles: z.number().int().positive().max(50).default(5),
      })
      .strict()
      .prefault({}),
    reports: z
      .object({
        formats: z
          .array(z.enum(['text', 'json', 'markdown', 'html', 'sarif']))
          .default(['json', 'markdown', 'html', 'sarif']),
      })
      .strict()
      .prefault({}),
    policy: z
      .object({
        confirmedViolation: z.enum(['fail', 'warn']).default('fail'),
        inconclusiveBehavior: z.enum(['fail', 'warn', 'ignore']).default('warn'),
        maxNewSurvivors: z.number().int().nonnegative().optional(),
        minPropertyCoverage: z.number().min(0).max(1).optional(),
      })
      .strict()
      .prefault({}),
    sandbox: z
      .object({
        /** Run project code even where network access cannot be blocked (Node.js below 25 without a newer one). */
        allowNetworkWithoutIsolation: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
    storage: z
      .object({
        retainRuns: z.number().int().positive().default(20),
        storePrompts: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
    cache: z
      .object({
        /** Reuse decisive solver results, LLM responses and mutation results from `.veritas/cache/`. */
        enabled: z.boolean().default(true),
      })
      .strict()
      .prefault({}),
    limits: z
      .object({
        /**
         * V8 heap limit in MiB for the processes Veritas starts for project code (restricted calls, property-based
         * tests, the project's test runner and mutator) and for the Z3 worker. Lean cannot be limited portably.
         */
        memoryMb: z.number().int().min(256).max(65536).default(2048),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type VeritasConfig = z.infer<typeof VeritasConfig>;
export type VeritasConfigInput = z.input<typeof VeritasConfig>;

/** Identity helper for `veritas.config.ts`, giving editor completion for the input shape. */
export function defineConfig(config: VeritasConfigInput): VeritasConfigInput {
  return config;
}
