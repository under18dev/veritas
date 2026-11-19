import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VeritasConfig } from '@veritas/core';
import { describe, expect, it } from 'vitest';
import { discoverEvidence } from '../src/index.js';

const repo = path.resolve(import.meta.dirname, '../../../');
const fixture = (name: string) => {
  const root = mkdtempSync(path.join(tmpdir(), `veritas-discovery-${name}-`));
  cpSync(path.join(repo, 'fixtures', name), root, { recursive: true });
  return root;
};
const config = (overrides: Record<string, unknown> = {}) =>
  VeritasConfig.parse({ sources: { local: true, ...overrides } });

describe('discoverEvidence', () => {
  it('extracts discount boundaries with source lines and stable IDs', async () => {
    const root = fixture('discount-boundary');
    const first = await discoverEvidence({
      root,
      config: config(),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const second = await discoverEvidence({
      root,
      config: config(),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const thresholds = first.statements.filter((s) => s.relation.kind === 'threshold');
    expect(thresholds.map((s) => [s.range.start, s.relation])).toEqual(
      expect.arrayContaining([
        [7, expect.objectContaining({ quantity: 'total', operator: '>=', value: '1000' })],
        [11, expect.objectContaining({ operator: '>=', value: '5000' })],
      ]),
    );
    expect(thresholds[0]?.relation).toEqual(
      expect.objectContaining({ consequence: expect.stringContaining('discount') }),
    );
    expect(first).toEqual(second);
  });

  it('collects exported issues and marks old documentation stale', async () => {
    const root = fixture('conflicting-docs');
    mkdirSync(path.join(root, '.veritas-sources', 'issues'), { recursive: true });
    writeFileSync(
      path.join(root, '.veritas-sources', 'issues', '42.json'),
      JSON.stringify({
        html_url: 'https://github.com/example/repo/issues/42',
        state: 'open',
        title: 'Limit',
        body: 'Requests are accepted for less than 120 per minute.',
      }),
    );
    const result = await discoverEvidence({ root, config: config() });
    expect(result.sources.some((s) => s.kind === 'issue' && s.locator.endsWith('/42'))).toBe(true);
    expect(
      result.statements.some(
        (s) => s.relation.kind === 'threshold' && s.relation.operator === '<' && s.relation.value === '120',
      ),
    ).toBe(true);
    expect(
      result.statements.some(
        (s) => s.flags.includes('stale') && s.relation.kind === 'threshold' && s.relation.value === '60',
      ),
    ).toBe(true);
  });

  it('retains prompt injection as flagged data without network or writes', async () => {
    const root = fixture('security');
    const result = await discoverEvidence({
      root,
      config: config({ web: { enabled: true, allowDomains: ['attacker.invalid'] } }),
      offline: true,
    });
    expect(result.networkRequests).toBe(0);
    expect(result.statements.some((s) => s.flags.includes('instruction_like'))).toBe(true);
    expect(
      result.statements.some(
        (s) => s.relation.kind === 'threshold' && s.relation.operator === '>=' && s.relation.value === '0',
      ),
    ).toBe(true);
  });

  it('redacts fetched content and enforces web allowlist, redirects, and page budgets', async () => {
    const root = fixture('no-spec');
    writeFileSync(
      path.join(root, 'README.md'),
      'See https://docs.example.test/start and https://127.0.0.1/private.',
    );
    let calls = 0;
    const fetcher: typeof fetch = async (input) => {
      calls++;
      const url = String(input);
      if (url.endsWith('/start'))
        return new Response('<p>At least 5 items are required. token=ghp_abcdefghijklmnopqrstuvwxyz</p>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      return new Response('', { status: 302, headers: { location: 'https://evil.test/' } });
    };
    const result = await discoverEvidence({
      root,
      config: config({
        web: {
          enabled: true,
          allowDomains: ['docs.example.test'],
          maxPages: 2,
          maxDepth: 1,
          maxChars: 1000,
          timeoutMs: 1000,
        },
      }),
      fetch: fetcher,
    });
    expect(calls).toBe(1);
    expect(result.networkRequests).toBe(1);
    expect(result.statements.some((s) => s.relation.kind === 'threshold' && s.relation.value === '5')).toBe(
      true,
    );
    expect(result.sources.every((s) => !s.summary.includes('ghp_'))).toBe(true);
    expect(result.skipped.some((s) => s.reason.includes('SSRF') || s.reason.includes('allowlist'))).toBe(
      true,
    );
  });

  it('makes no fetch calls when web is disabled or offline, including explicit source selection', async () => {
    const root = fixture('no-spec');
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return new Response('');
    };
    const disabled = await discoverEvidence({
      root,
      config: config({ web: { enabled: false, allowDomains: ['example.test'] } }),
      sources: ['web'],
      fetch: fetcher,
    });
    const offline = await discoverEvidence({
      root,
      config: config({ web: { enabled: true, allowDomains: ['example.test'] } }),
      sources: ['web'],
      offline: true,
      fetch: fetcher,
    });
    expect(disabled.networkRequests).toBe(0);
    expect(offline.networkRequests).toBe(0);
    expect(calls).toBe(0);
  });
});
