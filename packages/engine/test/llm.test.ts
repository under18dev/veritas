import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
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
});
