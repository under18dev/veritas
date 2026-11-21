import { z } from 'zod';
import { IntLiteral } from '../schema/ir.js';

const Domain = z.string().regex(/^[a-z0-9.-]+$/i, 'expected a bare domain name such as docs.example.com');

export const VeritasConfig = z
  .object({
    $schema: z
      .string()
      .optional()
      .describe('JSON Schema reference for editor completion; Veritas does not read it.'),
    schemaVersion: z
      .literal('1.0.0', {
        error: 'unsupported configuration schema version; this version of Veritas reads 1.0.0',
      })
      .default('1.0.0')
      .describe('Version of this configuration format.'),
    project: z
      .object({
        packageManager: z
          .enum(['pnpm', 'npm', 'yarn', 'bun', 'unknown'])
          .default('unknown')
          .describe("Package manager used to run the project's tools."),
        tsconfig: z
          .string()
          .nullable()
          .default(null)
          .describe(
            'tsconfig file used for code analysis, relative to the project root; null uses tsconfig.json.',
          ),
      })
      .strict()
      .default({ packageManager: 'unknown', tsconfig: null })
      .describe('The project being verified.'),
    sources: z
      .object({
        local: z.boolean().default(true).describe('Read specifications from documents in the repository.'),
        github: z
          .object({
            enabled: z
              .boolean()
              .default(false)
              .describe(
                'Read issues and pull requests of the repository from GitHub. Uses the network when a run is not offline.',
              ),
            // Exactly `owner/name`: anything else could point the token-bearing API request elsewhere.
            repo: z
              .string()
              .regex(
                /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/,
                'expected owner/name',
              )
              .optional()
              .describe('GitHub repository to read, as owner/name.'),
          })
          .strict()
          .default({ enabled: false })
          .describe('Issues and pull requests on GitHub as specification sources.'),
        web: z
          .object({
            enabled: z
              .boolean()
              .default(false)
              .describe(
                'Fetch web pages on the allowed domains. Uses the network when a run is not offline.',
              ),
            allowDomains: z
              .array(Domain)
              .default([])
              .describe('Domains web pages may be fetched from; no other domain is contacted.'),
            maxPages: z
              .number()
              .int()
              .positive()
              .max(1000)
              .default(30)
              .describe('Most web pages fetched in one run.'),
            maxDepth: z
              .number()
              .int()
              .nonnegative()
              .max(5)
              .default(1)
              .describe('How many links deep the crawl follows from a starting page.'),
            maxChars: z
              .number()
              .int()
              .positive()
              .default(200_000)
              .describe('Characters of page text read in total; the crawl stops beyond it.'),
            timeoutMs: z
              .number()
              .int()
              .positive()
              .default(30_000)
              .describe('Time allowed for one page request, in milliseconds.'),
            /** Total time for the whole crawl; pages not fetched by then are reported as skipped. */
            maxDurationMs: z
              .number()
              .int()
              .positive()
              .default(120_000)
              .describe('Time allowed for the whole crawl, in milliseconds.'),
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
          })
          .describe('Web pages as specification sources.'),
        sendFullTextToLlm: z
          .boolean()
          .default(false)
          .describe('Send whole source documents to the LLM instead of the relevant excerpts.'),
      })
      .strict()
      .prefault({})
      .describe('Where specifications come from. Network sources are off by default.'),
    analysis: z
      .object({
        include: z
          .array(z.string())
          .min(1)
          .default(['src/**/*.{ts,tsx,js,mjs}'])
          .describe('Glob patterns of the source files to analyze.'),
        exclude: z
          .array(z.string())
          .default(['**/*.generated.*', '**/node_modules/**', '**/dist/**'])
          .describe('Glob patterns of files never analyzed.'),
        testInclude: z
          .array(z.string())
          .default(['**/*.{test,spec}.{ts,tsx,js,mjs}'])
          .describe('Glob patterns of the test files.'),
        testFramework: z
          .literal('vitest')
          .default('vitest')
          .describe('Test framework; only Vitest is supported.'),
        inferSpecsFromCode: z
          .boolean()
          .default(true)
          .describe('Propose specifications inferred from code. They stay proposed until accepted.'),
        // An invariant: a property from documentation becomes accepted only through an explicit approval.
        requireApprovalForNormativeClaims: z
          .literal(true)
          .default(true)
          .describe('Specifications from documents need an explicit approval to become accepted.'),
      })
      .strict()
      .prefault({})
      .describe('Which files are analyzed and how specifications are inferred.'),
    mutation: z
      .object({
        backend: z
          .literal('mizchi')
          .default('mizchi')
          .describe('Mutation testing tool; only mutator (@mizchi/mutator) is supported.'),
        mode: z
          .enum(['diff', 'full'])
          .default('diff')
          .describe('diff mutates only the code changed since --since; full mutates everything in scope.'),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .default(120_000)
          .describe('Time allowed for mutation testing, in milliseconds.'),
      })
      .strict()
      .prefault({})
      .describe('Mutation testing with mutator.'),
    pbt: z
      .object({
        numRuns: z
          .number()
          .int()
          .positive()
          .max(1_000_000)
          .default(1000)
          .describe('Generated inputs tried per property.'),
        seed: z
          .number()
          .int()
          .optional()
          .describe('Fixed random seed; unset uses a stable seed per property.'),
      })
      .strict()
      .prefault({})
      .describe('Property-based testing with fast-check.'),
    formal: z
      .object({
        /** `both` checks every property with Z3 and also proves with Lean those it can translate. */
        backend: z.enum(['z3', 'lean', 'both']).default('z3').describe('Solver used for formal checks.'),
        integerDomain: z
          .object({
            min: IntLiteral.describe('Smallest integer input checked.'),
            max: IntLiteral.describe('Largest integer input checked.'),
          })
          .strict()
          .default({ min: '-10000', max: '10000' })
          .describe('Range integer inputs are checked over, as decimal strings.'),
        maxSolverMs: z
          .number()
          .int()
          .positive()
          .default(30_000)
          .describe('Time allowed for one solver call, in milliseconds.'),
        /** Arrays are modelled with a length in [0, maxArrayLength] and one parameter per element slot. */
        maxArrayLength: z
          .number()
          .int()
          .min(1)
          .max(8)
          .default(3)
          .describe('Longest array modelled in formal checks.'),
        rejectUnsupportedSemantics: z
          .literal(true)
          .default(true)
          .describe('Code outside the supported formal subset is reported as unsupported.'),
      })
      .strict()
      .prefault({})
      .describe('Formal checks with Z3 and Lean.'),
    llm: z
      .object({
        provider: z
          .enum(['none', 'claude', 'claude-code', 'openai', 'codex'])
          .default('none')
          .describe(
            'LLM that reads specifications; none uses no LLM. Sends text to the provider when a run is not offline.',
          ),
        model: z.string().optional().describe('Model name for the provider; unset uses its default.'),
        maxTokensPerRun: z
          .number()
          .int()
          .nonnegative()
          .default(200_000)
          .describe('Most LLM tokens one run may use.'),
        /** The codex CLI keeps a read-only shell that can read local files; it is only used with this set. */
        allowCodexFileReads: z
          .boolean()
          .default(false)
          .describe('Allow the codex provider, whose shell can read local files.'),
      })
      .strict()
      .prefault({})
      .describe('LLM provider used to read specifications. None by default.'),
    improvement: z
      .object({
        autoApply: z
          .literal(false)
          .default(false)
          .describe('Improvements are never applied without approval.'),
        // An invariant: improvements only add test files; production code is never edited.
        testFilesOnly: z.literal(true).default(true).describe('Improvements only add test files.'),
        maxIterations: z
          .number()
          .int()
          .positive()
          .max(20)
          .default(3)
          .describe('Most attempts an improvement may make.'),
        maxPatchFiles: z
          .number()
          .int()
          .positive()
          .max(50)
          .default(5)
          .describe('Most files one improvement may write.'),
      })
      .strict()
      .prefault({})
      .describe('Limits for test improvement plans.'),
    reports: z
      .object({
        formats: z
          .array(z.enum(['text', 'json', 'markdown', 'html', 'sarif']))
          .default(['json', 'markdown', 'html', 'sarif'])
          .describe('Report formats written for each run.'),
      })
      .strict()
      .prefault({})
      .describe('Report files written for each run.'),
    policy: z
      .object({
        confirmedViolation: z
          .enum(['fail', 'warn'])
          .default('fail')
          .describe('What a confirmed specification violation does to the exit code.'),
        inconclusiveBehavior: z
          .enum(['fail', 'warn', 'ignore'])
          .default('warn')
          .describe('What inconclusive results do to the exit code.'),
        maxNewSurvivors: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Fail when more mutants than this survive; unset turns the check off.'),
        minPropertyCoverage: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            'Fail when a smaller share (0 to 1) of accepted properties has a meaningful test; unset turns the check off.',
          ),
      })
      .strict()
      .prefault({})
      .describe('How results decide the exit code.'),
    sandbox: z
      .object({
        /** Run project code even where network access cannot be blocked (Node.js below 25 without a newer one). */
        allowNetworkWithoutIsolation: z
          .boolean()
          .default(false)
          .describe('Run project code even where its network access cannot be blocked.'),
      })
      .strict()
      .prefault({})
      .describe('How project code is isolated.'),
    storage: z
      .object({
        /** Run directories kept under `.veritas/runs`; older ones are removed when a run finishes. */
        retainRuns: z
          .number()
          .int()
          .positive()
          .default(20)
          .describe('Run directories kept; older ones are removed.'),
        // An invariant: prompts sent to an LLM are not stored with the run artifacts.
        storePrompts: z.literal(false).default(false).describe('Prompts sent to an LLM are never stored.'),
      })
      .strict()
      .prefault({})
      .describe('What is kept under .veritas.'),
    cache: z
      .object({
        /** Reuse decisive solver results, LLM responses and mutation results from `.veritas/cache/`. */
        enabled: z
          .boolean()
          .default(true)
          .describe('Reuse solver, LLM and mutation results from earlier runs.'),
      })
      .strict()
      .prefault({})
      .describe('Result cache under .veritas/cache.'),
    limits: z
      .object({
        /**
         * V8 heap limit in MiB for the processes Veritas starts for project code (restricted calls, property-based
         * tests, the project's test runner and mutator) and for the Z3 solver process. Lean cannot be limited portably.
         */
        memoryMb: z
          .number()
          .int()
          .min(256)
          .max(65536)
          .default(2048)
          .describe('Memory limit for project code and Z3 processes, in MiB.'),
      })
      .strict()
      .prefault({})
      .describe('Resource limits for the processes Veritas starts.'),
  })
  .strict();

export type VeritasConfig = z.infer<typeof VeritasConfig>;
export type VeritasConfigInput = z.input<typeof VeritasConfig>;

/** Identity helper for `veritas.config.ts`, giving editor completion for the input shape. */
export function defineConfig(config: VeritasConfigInput): VeritasConfigInput {
  return config;
}
