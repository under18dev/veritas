import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { redact, type StageName, TOOL_VERSION, VeritasError } from '@under18dev/veritas-core';
import {
  COMMAND_STAGES,
  explainFinding,
  listProperties,
  propertyConfig,
  type RunSummary,
  readArtifact,
  readLatest,
  runVeritas,
} from '@under18dev/veritas-engine';
import { applyImprovement, planImprovement } from '@under18dev/veritas-improvement';
import { z } from 'zod';

export interface ServerOptions {
  /** Project root. Every tool operates inside it; no tool accepts a path outside it. */
  root: string;
  /** Maximum number of long-running operations at the same time. */
  maxConcurrent?: number;
  version?: string;
  /**
   * Register `apply_approved_improvement`. Off by default: without it the server can never change project files.
   * Even when on, every apply needs the plan id and the approval token that the plan's owner reviewed.
   */
  allowWrite?: boolean;
}

const Id = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}-[0-9a-f]{6,64}$`), `expected a ${prefix}-<hex> id`);
const RunId = z.string().regex(/^run-[A-Za-z0-9-]{1,80}$/);
const GitRef = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9._/@~^-]+$/, 'not a plain git ref')
  .refine((s) => !s.startsWith('-'), 'refs may not start with -');
/** A path or glob relative to the project root; anything resolving outside it is refused again by the engine. */
const ProjectPath = z
  .string()
  .min(1)
  .max(500)
  .refine((s) => !s.startsWith('-') && !s.includes('\0'), 'not a plain project path')
  .refine(
    (s) => !/^([A-Za-z]:|[\\/])/.test(s) && !s.split(/[\\/]/).includes('..'),
    'must stay inside the project',
  );

/** Limits concurrent long operations; extra calls wait their turn (or are cancelled while waiting). */
class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    while (this.active >= this.max) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () =>
          reject(new VeritasError('tool', 'CANCELLED', 'cancelled while waiting for another operation'));
        signal.addEventListener('abort', onAbort, { once: true });
        this.waiting.push(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        });
      });
    }
    this.active++;

    try {
      return await task();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

function ok(data: unknown): CallToolResult {
  const text = redact(JSON.stringify(data, null, 2));

  return {
    content: [{ type: 'text', text }],
    structuredContent: JSON.parse(text) as Record<string, unknown>,
  };
}

function fail(error: unknown): CallToolResult {
  const body =
    error instanceof VeritasError
      ? { code: error.code, category: error.category, message: error.message, hint: error.hint ?? null }
      : {
          code: 'UNEXPECTED',
          category: 'tool',
          message: (error as Error)?.message ?? String(error),
          hint: null,
        };

  return { isError: true, content: [{ type: 'text', text: redact(JSON.stringify(body)) }] };
}

type Extra = {
  signal: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification: (n: never) => Promise<void>;
};

function summarize(summary: RunSummary) {
  return {
    runId: summary.runId,
    verdict: summary.decision.verdict,
    exitCode: summary.decision.exitCode,
    reasons: summary.decision.reasons,
    stages: summary.run.stages.map((s) => ({ stage: s.stage, status: s.status, messages: s.messages })),
    findings: summary.findings.map((f) => ({
      id: f.id,
      kind: f.kind,
      certainty: f.certainty,
      severity: f.severity,
      title: f.title,
    })),
  };
}

/**
 * Build the Veritas MCP server. Read tools run analysis stages that only write under `.veritas/`; they never
 * modify project sources. Tools that would change project files are not part of this server unless an approved
 * improvement API is registered separately with an approval token.
 */
export function createServer(options: ServerOptions): McpServer {
  // Programmatic callers get the same checks as the command: an existing directory and a sane concurrency limit.
  const maxConcurrent = options.maxConcurrent ?? 1;

  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16)
    throw new VeritasError('user', 'OPTION_INVALID', 'maxConcurrent must be an integer from 1 to 16');
  let root: string;

  try {
    root = realpathSync(path.resolve(options.root));
  } catch {
    throw new VeritasError('user', 'ROOT_NOT_FOUND', `project root does not exist: ${options.root}`);
  }

  if (!statSync(root).isDirectory())
    throw new VeritasError('user', 'ROOT_NOT_FOUND', `project root is not a directory: ${options.root}`);
  const server = new McpServer({ name: 'veritas', version: options.version ?? TOOL_VERSION });
  const gate = new Semaphore(maxConcurrent);

  const runStages = (
    extra: Extra,
    command: string,
    stages: StageName[],
    extraOptions: Partial<Parameters<typeof runVeritas>[0]> = {},
  ) =>
    gate.run(extra.signal, async () => {
      let step = 0;
      const progressToken = extra._meta?.progressToken;

      return runVeritas({
        root,
        command: `mcp:${command}`,
        stages,
        offline: true,
        signal: extra.signal,
        log: (message) => {
          step++;

          if (progressToken !== undefined) {
            void extra
              .sendNotification({
                method: 'notifications/progress',
                params: { progressToken, progress: step, total: stages.length + 1, message: redact(message) },
              } as never)
              .catch(() => {});
          }
        },
        ...extraOptions,
      });
    });

  server.registerTool(
    'discover_specs',
    {
      description:
        'Collect specification evidence (README, docs, JSDoc, schemas, git history, exported issues). Offline; network sources stay disabled.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_args, extra) => {
      try {
        const summary = await runStages(extra as unknown as Extra, 'discover_specs', [
          ...COMMAND_STAGES.discover,
        ]);
        const evidence = readArtifact(root, summary.runId, 'evidence').data;

        return ok({
          ...summarize(summary),
          sources: evidence.sources.map((s) => ({
            id: s.id,
            kind: s.kind,
            locator: s.locator,
            range: s.range ?? null,
            summary: s.summary,
            trust: s.trust,
          })),
          statements: evidence.statements,
          skipped: evidence.skipped,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'list_properties',
    {
      description:
        'List properties of the latest run, and the declared properties of the configuration, with their review status, origin and sources. Approvals cannot be changed through MCP.',
      inputSchema: {
        status: z
          .enum(['proposed', 'reviewed', 'accepted', 'rejected', 'conflicted', 'superseded'])
          .optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ status }) => {
      try {
        const config = await propertyConfig(root);
        const { runId, properties } = listProperties(root, config ? { config } : {});

        return ok({ runId, properties: properties.filter((p) => !status || p.status === status) });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'analyze_tests',
    {
      description:
        'Index code and tests, map tests to properties and assess each test with an evidence vector (no mutation run).',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_args, extra) => {
      try {
        const summary = await runStages(extra as unknown as Extra, 'analyze_tests', [
          ...COMMAND_STAGES.analyze,
        ]);

        return ok({
          ...summarize(summary),
          assessments: readArtifact(root, summary.runId, 'assessments').data,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'run_mutation',
    {
      description: 'Run mutation testing (real mutator) and relate mutants to properties and tests.',
      inputSchema: {
        since: GitRef.optional(),
        scope: ProjectPath.optional().describe('source glob to mutate, relative to the project'),
        killMatrix: z.boolean().default(false).describe('run every covering test for every mutant (slower)'),
        reportFile: ProjectPath.optional().describe(
          'import this mutation-testing-elements report instead of running mutator',
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ since, scope, killMatrix, reportFile }, extra) => {
      try {
        if (reportFile && killMatrix)
          throw new VeritasError(
            'user',
            'OPTION_CONFLICT',
            'reportFile is read as is; killMatrix needs a run',
          );
        const summary = await runStages(
          extra as unknown as Extra,
          'run_mutation',
          [...COMMAND_STAGES.mutate],
          {
            ...(since ? { since } : {}),
            ...(scope ? { scope: [scope] } : {}),
            ...(killMatrix ? { killMatrix: true } : {}),
            ...(reportFile ? { mutationReport: reportFile } : {}),
          },
        );
        const mutation = readArtifact(root, summary.runId, 'mutation').data;

        return ok({ ...summarize(summary), counts: mutation.counts, mutants: mutation.mutants });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'verify_property',
    {
      description:
        'Check formalized properties with the configured formal backend (formal.backend: Z3 by default, Lean, or both) within a bounded integer model, replaying counterexamples in JavaScript. Results are "proven within the model" at best, never a general proof.',
      inputSchema: { propertyId: Id('P').optional(), includeProposed: z.boolean().default(false) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ propertyId, includeProposed }, extra) => {
      try {
        const summary = await runStages(
          extra as unknown as Extra,
          'verify_property',
          [...COMMAND_STAGES.prove],
          {
            includeProposed,
            ...(propertyId ? { propertyIds: [propertyId] } : {}),
          },
        );
        const claims = (() => {
          try {
            return readArtifact(root, summary.runId, 'claims').data;
          } catch {
            return [];
          }
        })();

        return ok({ ...summarize(summary), claims });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'get_evidence',
    {
      description:
        'Return the evidence chain of a finding: sources and quotes, properties, tests, assessments, mutants and solver claims.',
      inputSchema: { findingId: Id('F') },
      annotations: { readOnlyHint: true },
    },
    async ({ findingId }) => {
      try {
        return ok(explainFinding(root, findingId));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'get_run_status',
    {
      description: 'Return the status, stages, verdict and usage of a run (default: the latest).',
      inputSchema: { runId: RunId.optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ runId }) => {
      try {
        const run = runId ? readArtifact(root, runId, 'run').data : readLatest(root, 'run').data;

        return ok({ run });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'plan_improvement',
    {
      description:
        'Plan test-only improvements from the latest run (no project files are changed). Returns the plan, spec violation candidates and the approval token a person must review before anything is applied.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_args, extra) => {
      try {
        const { signal } = extra as unknown as Extra;
        const result = await gate.run(signal, () => planImprovement({ root, signal }));

        return ok(result);
      } catch (error) {
        return fail(error);
      }
    },
  );

  if (options.allowWrite) {
    server.registerTool(
      'apply_approved_improvement',
      {
        description:
          'Apply a reviewed improvement plan. Requires the exact plan id and approval token; adds new test files only, after measuring the improvement in an isolated copy, and rolls back otherwise. Refused in CI.',
        inputSchema: {
          planId: z.string().regex(/^IP-[0-9a-f]{6,64}$/, 'expected an IP-<hex> plan id'),
          approvalToken: z.string().regex(/^[0-9a-f]{64}$/, 'expected the 64-character approval token'),
          actor: z
            .string()
            .min(1)
            .max(200)
            .optional()
            .describe('the person who approved the plan (recorded)'),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ planId, approvalToken, actor }, extra) => {
        try {
          const { signal } = extra as unknown as Extra;
          const attempt = await gate.run(signal, () =>
            applyImprovement({
              root,
              planId,
              approvalToken,
              signal,
              via: 'mcp',
              ...(actor ? { actor } : {}),
            }),
          );

          return ok({ attempt });
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  return server;
}
