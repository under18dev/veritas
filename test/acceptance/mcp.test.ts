import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  EvidenceSource,
  Finding,
  FormalClaim,
  Mutant,
  Property,
  Run,
  TestAssessment,
  TestCase,
} from '@under18dev/veritas-core';
import { afterEach, describe, expect, it } from 'vitest';
import { copyFixture, REPO_ROOT, runCli } from './helpers.js';

const BIN = path.join(REPO_ROOT, 'packages/mcp/dist/bin.js');
const clients: Client[] = [];

async function connect(root: string, extraArgs: string[] = []): Promise<Client> {
  const client = new Client({ name: 'veritas-acceptance', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [BIN, '--root', root, ...extraArgs],
      stderr: 'ignore',
    }),
  );
  clients.push(client);
  return client;
}

function data(result: unknown): Record<string, unknown> {
  const r = result as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content: { text: string }[];
  };
  if (r.isError) throw new Error(r.content[0]?.text);
  return r.structuredContent ?? JSON.parse(r.content[0]?.text ?? '{}');
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
});

describe('MCP server', () => {
  it('runs discover -> analyze -> verify -> evidence -> status from an MCP client', async () => {
    const dir = copyFixture('discount-boundary', { git: true, linkDeps: true });
    expect(runCli(['init', '--yes'], dir).status).toBe(0);
    const client = await connect(dir);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([
      'analyze_tests',
      'discover_specs',
      'get_evidence',
      'get_run_status',
      'list_properties',
      'plan_improvement',
      'run_mutation',
      'verify_property',
    ]);
    for (const t of (await client.listTools()).tools) expect(t.annotations?.readOnlyHint).toBe(true);

    const discovered = data(await client.callTool({ name: 'discover_specs', arguments: {} }));
    const sources = discovered.sources as { kind: string; locator: string; trust: string }[];
    expect(sources.some((s) => s.kind === 'readme' && s.locator === 'README.md')).toBe(true);
    expect(sources.every((s) => s.trust === 'untrusted_data')).toBe(true);

    const analyzed = data(await client.callTool({ name: 'analyze_tests', arguments: {} }));
    expect((analyzed.assessments as unknown[]).length).toBe(5);

    const verified = data(
      await client.callTool({ name: 'verify_property', arguments: { includeProposed: true } }),
    );
    const claims = verified.claims as { status: string; counterexample?: Record<string, string> }[];
    expect(
      claims.some((c) => c.status === 'counterexample_found' && c.counterexample?.total === '1000'),
    ).toBe(true);
    const finding = (verified.findings as { id: string; kind: string }[]).find(
      (f) => f.kind === 'spec_implementation_mismatch',
    );

    const evidence = data(
      await client.callTool({ name: 'get_evidence', arguments: { findingId: finding?.id } }),
    );
    expect((evidence.statements as { range: { start: number } }[])[0]?.range.start).toBe(7);

    const status = data(await client.callTool({ name: 'get_run_status', arguments: {} }));
    expect((status.run as { id: string }).id).toBe(verified.runId);

    // Read tools never touch project sources.
    expect(
      execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' })
        .split('\n')
        .filter((l) => l && !l.includes('.veritas/')),
    ).toEqual([]);
  }, 300_000);

  it('rejects malformed, oversized and traversal-shaped arguments', async () => {
    const dir = copyFixture('discount-boundary', { git: true, linkDeps: true });
    expect(runCli(['init', '--yes'], dir).status).toBe(0);
    const client = await connect(dir);
    for (const args of [
      { findingId: '../../etc/passwd' },
      { findingId: 'F-zz' },
      { findingId: `F-${'a'.repeat(5000)}` },
    ]) {
      const result = (await client.callTool({ name: 'get_evidence', arguments: args })) as {
        isError?: boolean;
      };
      expect(result.isError).toBe(true);
    }
    const bad = (await client.callTool({
      name: 'run_mutation',
      arguments: { since: '--upload-pack=evil' },
    })) as { isError?: boolean };
    expect(bad.isError).toBe(true);
    const run = (await client.callTool({ name: 'get_run_status', arguments: { runId: '../../x' } })) as {
      isError?: boolean;
    };
    expect(run.isError).toBe(true);
  }, 120_000);

  it('never writes project files without --allow-write, a plan id and the approval token', async () => {
    const dir = copyFixture('agent-loop', { git: true, linkDeps: true });
    expect(runCli(['init', '--yes'], dir).status).toBe(0);
    expect(runCli(['run', '--profile', 'deep', '--include-proposed'], dir).status).toBe(0);
    const listed = JSON.parse(runCli(['spec', 'list', '--json'], dir).stdout) as {
      properties: { id: string; origin: string }[];
    };
    const rule = listed.properties.find((p) => p.origin === 'normative');
    expect(
      runCli(['spec', 'accept', rule?.id as string, '--reason', 'README rule', '--actor', 'reviewer'], dir)
        .status,
    ).toBe(0);
    const status = () =>
      execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' })
        .split('\n')
        .filter(
          (l) => l && !l.includes('.veritas/') && !l.includes('.mutator/') && !l.includes('node_modules/'),
        );
    const before = status();

    const readOnly = await connect(dir);
    expect((await readOnly.listTools()).tools.map((t) => t.name)).not.toContain('apply_approved_improvement');
    const plan = data(await readOnly.callTool({ name: 'plan_improvement', arguments: {} })) as {
      planId: string;
      approvalToken: string;
    };
    expect(plan.planId).toMatch(/^IP-/);
    const refused = (await readOnly.callTool({
      name: 'apply_approved_improvement',
      arguments: { planId: plan.planId, approvalToken: plan.approvalToken },
    })) as { isError?: boolean };
    expect(refused.isError).toBe(true);
    expect(status()).toEqual(before);

    const writer = await connect(dir, ['--allow-write']);
    const wrongToken = (await writer.callTool({
      name: 'apply_approved_improvement',
      arguments: { planId: plan.planId, approvalToken: 'f'.repeat(64) },
    })) as { isError?: boolean };
    expect(wrongToken.isError).toBe(true);
    const missingToken = (await writer.callTool({
      name: 'apply_approved_improvement',
      arguments: { planId: plan.planId },
    })) as { isError?: boolean };
    expect(missingToken.isError).toBe(true);
    expect(status()).toEqual(before);

    const applied = data(
      await writer.callTool({
        name: 'apply_approved_improvement',
        arguments: { planId: plan.planId, approvalToken: plan.approvalToken },
      }),
    ) as {
      attempt: { outcome: string; before: { mutantsKilled: number }; after: { mutantsKilled: number } };
    };
    expect(applied.attempt.outcome).toBe('improved');
    expect(applied.attempt.after.mutantsKilled).toBeGreaterThan(applied.attempt.before.mutantsKilled);
    const added = status().filter((l) => !before.includes(l));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/^\?\? test\/veritas-.*\.test\.ts$/);
  }, 600_000);

  it('reports a cancelled tool call as cancelled, records the run as not successful and stays usable', async () => {
    const dir = copyFixture('discount-boundary', { git: true, linkDeps: true });
    expect(runCli(['init', '--yes'], dir).status).toBe(0);
    const client = await connect(dir);
    const runsDir = path.join(dir, '.veritas/runs');
    const controller = new AbortController();
    // Cancel once mutator has been started (its report directory is created right before it is spawned).
    const poll = setInterval(() => {
      if (!existsSync(runsDir)) return;
      if (readdirSync(runsDir).some((r) => existsSync(path.join(runsDir, r, 'mutation')))) {
        clearInterval(poll);
        controller.abort('cancelled by the acceptance test');
      }
    }, 20);
    const call = client.callTool({ name: 'run_mutation', arguments: {} }, undefined, {
      signal: controller.signal,
      timeout: 240_000,
    });
    await expect(call).rejects.toThrow(/cancelled by the acceptance test/);
    clearInterval(poll);
    expect(controller.signal.aborted).toBe(true);

    // The server is still usable: a long tool runs once the cancelled one has released its slot.
    const analyzed = data(await client.callTool({ name: 'analyze_tests', arguments: {} }));
    expect(analyzed.verdict).not.toBe('tool_error');
    expect((analyzed.assessments as unknown[]).length).toBe(5);

    const runs = readdirSync(runsDir).map(
      (id) =>
        JSON.parse(readFileSync(path.join(runsDir, id, 'run.json'), 'utf8')).data as {
          command: string;
          status: string;
          verdict: string;
          stages: { stage: string; status: string }[];
        },
    );
    const cancelled = runs.find((r) => r.command === 'mcp:run_mutation');
    expect(cancelled?.stages.find((s) => s.stage === 'mutate')?.status).toBe('cancelled');
    expect(cancelled?.status).not.toBe('succeeded');
    expect(cancelled?.verdict).not.toBe('pass');
    const status = data(await client.callTool({ name: 'get_run_status', arguments: {} }));
    expect((status.run as { command: string }).command).toBe('mcp:analyze_tests');
  }, 300_000);

  it('returns read-tool results that validate against the core schemas and carry their provenance', async () => {
    const dir = copyFixture('discount-boundary', { git: true, linkDeps: true });
    expect(runCli(['init', '--yes'], dir).status).toBe(0);
    const client = await connect(dir);
    const expectValid = (
      schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } },
      v: unknown,
    ) => {
      const parsed = schema.safeParse(v);
      expect(parsed.success, JSON.stringify(parsed.error)).toBe(true);
    };

    const discovered = data(await client.callTool({ name: 'discover_specs', arguments: {} }));
    const sources = discovered.sources as Record<string, unknown>[];
    expect(sources.length).toBeGreaterThan(0);
    for (const s of sources)
      expectValid(
        EvidenceSource.pick({ id: true, kind: true, locator: true, summary: true, trust: true }),
        s,
      );

    const verified = data(
      await client.callTool({ name: 'verify_property', arguments: { includeProposed: true } }),
    );
    for (const c of verified.claims as unknown[]) expectValid(FormalClaim, c);
    const finding = (verified.findings as { id: string; kind: string }[]).find(
      (f) => f.kind === 'spec_implementation_mismatch',
    );

    const listed = data(await client.callTool({ name: 'list_properties', arguments: {} }));
    const properties = (listed.properties as unknown[]).map((p) => Property.parse(p));
    const normative = properties.filter((p) => p.origin === 'normative');
    expect(normative.length).toBeGreaterThan(0);
    for (const p of normative) {
      expect(p.sourceIds.length).toBeGreaterThan(0);
      expect(p.citations.length).toBeGreaterThan(0);
      for (const c of p.citations) expect(c).toMatch(/^README\.md:\d+$/);
    }

    // get_evidence reads the latest run: the verification run above.
    const evidence = data(
      await client.callTool({ name: 'get_evidence', arguments: { findingId: finding?.id } }),
    );
    const f = Finding.parse(evidence.finding);
    expect(f.id).toBe(finding?.id);
    expect(f.sourceIds.length).toBeGreaterThan(0);
    for (const p of evidence.properties as unknown[]) expectValid(Property, p);
    const evidenceSources = (evidence.sources as unknown[]).map((s) => EvidenceSource.parse(s));
    expect(evidenceSources.map((s) => s.id)).toEqual(expect.arrayContaining(f.sourceIds));
    expect(evidenceSources.find((s) => s.locator === 'README.md')?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const statements = evidence.statements as { sourceId: string; quote: string; range: { start: number } }[];
    expect(statements.some((s) => s.range.start === 7 && /1000 or more/.test(s.quote))).toBe(true);
    for (const s of statements) expect(evidenceSources.map((x) => x.id)).toContain(s.sourceId);
    for (const t of evidence.tests as unknown[]) expectValid(TestCase, t);
    for (const m of evidence.mutants as unknown[]) expectValid(Mutant, m);
    for (const c of evidence.claims as unknown[]) expectValid(FormalClaim, c);
    expect((evidence.claims as unknown[]).length).toBeGreaterThan(0);
    for (const a of evidence.assessments as unknown[]) expectValid(TestAssessment, a);

    const analyzed = data(await client.callTool({ name: 'analyze_tests', arguments: {} }));
    expect((analyzed.assessments as unknown[]).length).toBe(5);
    for (const a of analyzed.assessments as unknown[]) expectValid(TestAssessment, a);

    const status = data(await client.callTool({ name: 'get_run_status', arguments: {} }));
    expectValid(Run, status.run);
  }, 300_000);

  it('prints usage for --help and rejects unknown options with exit code 2', () => {
    const help = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--allow-write');
    const bad = spawnSync(process.execPath, [BIN, '--bogus'], { encoding: 'utf8' });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("Unknown option '--bogus'");
    expect(bad.stderr).not.toContain('at parseArgs');
  });
});
