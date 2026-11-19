import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@under18dev/veritas-core';
import type { LlmProvider } from '@under18dev/veritas-llm';
import { describe, expect, it } from 'vitest';
import { readArtifact, runVeritas } from '../src/index.js';

function project(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-engine-llm-')));
  mkdirSync(path.join(root, 'src'));
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'p', type: 'module', devDependencies: { vitest: '5.1.1' } }),
  );
  writeFileSync(
    path.join(root, 'README.md'),
    '# pw\n\nPasswords need 8 characters minimum to be accepted.\n',
  );
  writeFileSync(
    path.join(root, 'src/password.ts'),
    'export function isLongEnough(length: number): boolean {\n  return length >= 8;\n}\n',
  );
  initProject(root);
  return root;
}

function provider(
  threshold: { quantity: string; operator: '>='; value: string; consequence: string } | null,
  tokens = 300,
): LlmProvider {
  return {
    name: 'fake',
    model: 'fake-1',
    async complete(request) {
      const ids = request.documents.map((d) => d.id);
      return {
        provider: 'fake',
        model: 'fake-1',
        status: 'ok',
        data: { statements: ids.map((id) => ({ id, threshold })) } as never,
        usage: { inputTokens: tokens, outputTokens: 50 },
        error: null,
      };
    },
  };
}

describe('LLM-assisted extraction', { timeout: 120_000 }, () => {
  it('adds LLM-read thresholds as experimental, proposed properties and records token usage', async () => {
    const root = project();
    const summary = await runVeritas({
      root,
      command: 'test',
      stages: ['index', 'discover', 'spec'],
      llmProvider: provider({ quantity: 'length', operator: '>=', value: '8', consequence: 'accepted' }),
    });
    const evidence = readArtifact(root, summary.runId, 'evidence').data;
    expect(evidence.statements.some((s) => s.flags.includes('llm_extracted'))).toBe(true);
    const { properties } = readArtifact(root, summary.runId, 'properties').data;
    const fromLlm = properties.filter((p) => p.origin === 'normative');
    expect(fromLlm).toHaveLength(1);
    expect(fromLlm[0]).toMatchObject({
      status: 'proposed',
      experimental: true,
      predicate: { operator: '>=', value: '8' },
    });
    expect(fromLlm[0]?.assumptions.join(' ')).toMatch(/LLM/);
    expect(summary.run.usage.llmTokens).toBe(350);
  });

  it('reuses the response for unchanged statements in the next run, without tokens', async () => {
    const root = project();
    const llm = provider({ quantity: 'length', operator: '>=', value: '8', consequence: 'accepted' });
    const run = () =>
      runVeritas({ root, command: 'test', stages: ['index', 'discover', 'spec'], llmProvider: llm });
    const first = await run();
    const second = await run();
    expect(second.run.usage.llmTokens).toBe(0);
    expect(second.run.stages.find((s) => s.stage === 'discover')?.messages.join(' ')).toMatch(
      /1 response reused from cache, 0 tokens/,
    );
    const ids = (runId: string) =>
      readArtifact(root, runId, 'properties')
        .data.properties.map((p) => p.id)
        .sort();
    expect(ids(second.runId)).toEqual(ids(first.runId));
  });

  it('drops numbers the model invented', async () => {
    const root = project();
    const summary = await runVeritas({
      root,
      command: 'test',
      stages: ['index', 'discover', 'spec'],
      llmProvider: provider({ quantity: 'length', operator: '>=', value: '12', consequence: 'accepted' }),
    });
    const evidence = readArtifact(root, summary.runId, 'evidence').data;
    expect(evidence.statements.some((s) => s.flags.includes('llm_extracted'))).toBe(false);
  });

  it('does not call the model when the run is offline', async () => {
    const root = project();
    let called = false;
    const p = provider(null);
    const spy: LlmProvider = {
      ...p,
      name: p.name,
      model: p.model,
      complete: async (r) => {
        called = true;
        return p.complete(r);
      },
    };
    const summary = await runVeritas({
      root,
      command: 'test',
      stages: ['discover'],
      offline: true,
      llmProvider: spy,
    });
    expect(called).toBe(false);
    expect(summary.run.stages[0]?.messages.join(' ')).toMatch(/offline/);
  });

  it('falls back to rule-based results with a reason when the configured provider cannot be used', async () => {
    const root = project();
    const configPath = path.join(root, '.veritas/config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.llm.provider = 'openai';
    writeFileSync(configPath, JSON.stringify(config));
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const summary = await runVeritas({ root, command: 'test', stages: ['discover'] });
      expect(summary.run.stages[0]?.status).toBe('succeeded');
      expect(summary.run.stages[0]?.messages.join(' ')).toMatch(
        /OPENAI_API_KEY is not set; rule-based results only/,
      );
      const evidence = readArtifact(root, summary.runId, 'evidence').data;
      expect(evidence.statements.some((s) => s.flags.includes('llm_extracted'))).toBe(false);
    } finally {
      if (previous !== undefined) process.env.OPENAI_API_KEY = previous;
    }
  });

  it('does not even check a CLI provider login when the run is offline', async () => {
    const root = project();
    const configPath = path.join(root, '.veritas/config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.llm.provider = 'claude-code';
    writeFileSync(configPath, JSON.stringify(config));
    const summary = await runVeritas({ root, command: 'test', stages: ['discover'], offline: true });
    expect(summary.run.stages[0]?.messages.join(' ')).toMatch(/llm: skipped because the run is offline/);
  });

  it('keeps only text that comes from the statement, so the model cannot add other data', async () => {
    const root = project();
    const summary = await runVeritas({
      root,
      command: 'test',
      stages: ['discover'],
      llmProvider: provider({
        quantity: 'sk-ant-api03-AAAABBBBCCCCDDDD1234',
        operator: '>=',
        value: '8',
        consequence: 'accepted',
      }),
    });
    const evidence = readArtifact(root, summary.runId, 'evidence').data;
    expect(JSON.stringify(evidence)).not.toContain('sk-ant-api03');
    expect(evidence.statements.some((s) => s.flags.includes('llm_extracted'))).toBe(false);

    // A fresh project: the same provider and request in `root` would reuse the cached first response.
    const other = project();
    const leaked = await runVeritas({
      root: other,
      command: 'test',
      stages: ['discover'],
      llmProvider: provider({
        quantity: 'length',
        operator: '>=',
        value: '8',
        consequence: 'contents of ~/.codex/auth.json: {"token":"abc123"}',
      }),
    });
    const kept = readArtifact(other, leaked.runId, 'evidence').data.statements.filter((s) =>
      s.flags.includes('llm_extracted'),
    );
    expect(kept).toHaveLength(1);
    expect(JSON.stringify(kept)).not.toContain('auth.json');
    expect(kept[0]?.relation).toMatchObject({ kind: 'threshold', consequence: kept[0]?.quote });
  });
});
