import { VeritasConfig } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import { DiscoveryResult, discoverEvidence } from '../src/index.js';
import { tempProject } from './helpers.js';

describe('GitHub collector', () => {
  it('fetches only when enabled and online, sends the token, and maps issues and PRs', async () => {
    const root = tempProject('github');
    const seen: RequestInit[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      seen.push(init ?? {});
      return Response.json([
        {
          html_url: 'https://github.com/acme/app/issues/1',
          state: 'open',
          title: 'Issue',
          body: 'At most 10 requests.',
        },
        {
          html_url: 'https://github.com/acme/app/pull/2',
          state: 'closed',
          title: 'PR',
          body: 'The value must be at least 2.',
          pull_request: {},
        },
      ]);
    };
    const oldToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz';
    try {
      const result = await discoverEvidence({
        root,
        config: VeritasConfig.parse({ sources: { github: { enabled: true, repo: 'acme/app' } } }),
        sources: ['github'],
        fetch: fetcher,
      });
      expect(seen[0]?.headers).toEqual(
        expect.objectContaining({ authorization: 'Bearer ghp_abcdefghijklmnopqrstuvwxyz' }),
      );
      expect(result.networkRequests).toBe(1);
      expect(result.sources.map((source) => source.kind)).toEqual(['issue', 'pr']);
      expect(JSON.stringify(result)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
      expect(
        result.statements.some(
          (statement) => statement.relation.kind === 'threshold' && statement.relation.value === '10',
        ),
      ).toBe(true);
    } finally {
      if (oldToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = oldToken;
    }
  });

  it('skips online API failures without throwing and makes no offline request', async () => {
    const root = tempProject('github-failure');
    const failure = await discoverEvidence({
      root,
      config: VeritasConfig.parse({ sources: { github: { enabled: true, repo: 'acme/app' } } }),
      sources: ['github'],
      fetch: async () => new Response('nope', { status: 503 }),
    });
    expect(failure.networkRequests).toBe(1);
    expect(failure.skipped).toContainEqual({ source: 'github', reason: 'fetch failed (503)' });
    let calls = 0;
    const offline = await discoverEvidence({
      root,
      config: VeritasConfig.parse({ sources: { github: { enabled: true, repo: 'acme/app' } } }),
      sources: ['github'],
      offline: true,
      fetch: async () => {
        calls++;
        return Response.json([]);
      },
    });
    expect(offline.networkRequests).toBe(0);
    expect(calls).toBe(0);
    expect(DiscoveryResult.parse(offline)).toEqual(offline);
  });
});
