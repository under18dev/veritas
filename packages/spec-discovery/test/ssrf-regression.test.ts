import { writeFileSync } from 'node:fs';
import { VeritasConfig } from '@veritas/core';
import { describe, expect, it } from 'vitest';
import { discoverEvidence, isUnsafeHost } from '../src/index.js';
import { config, tempProject } from './helpers.js';

type Lookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const webConfig = (allowDomains: string[]) =>
  config({
    web: { enabled: true, allowDomains, maxPages: 10, maxDepth: 0, maxChars: 1000, timeoutMs: 1000 },
  });

function recordingFetch(): { fetch: typeof fetch; requested: string[] } {
  const requested: string[] = [];
  return {
    requested,
    fetch: async (input) => {
      requested.push(String(input));
      return new Response('<p>The total must be at least 10.</p>');
    },
  };
}

describe('SSRF: DNS resolution before fetching', () => {
  it('refuses an allowlisted hostname that resolves to a loopback address before any request', async () => {
    const root = tempProject('dns-loopback');
    writeFileSync(`${root}/README.md`, 'See https://allowed.example/ for details.');
    const { fetch, requested } = recordingFetch();
    const lookups: string[] = [];
    const lookup: Lookup = async (hostname) => {
      lookups.push(hostname);
      return [{ address: '127.0.0.1', family: 4 }];
    };
    const result = await discoverEvidence({
      root,
      config: webConfig(['allowed.example']),
      fetch,
      lookup,
    });
    expect(lookups).toEqual(['allowed.example']);
    expect(requested).toEqual([]);
    expect(result.networkRequests).toBe(0);
    expect(result.skipped).toContainEqual({
      source: 'https://allowed.example/',
      reason: 'URL refused: host resolves to a private, loopback, or reserved address',
    });
  });

  it('refuses when any one of several resolved addresses is private', async () => {
    const root = tempProject('dns-mixed');
    writeFileSync(`${root}/README.md`, 'https://allowed.example/a');
    const { fetch, requested } = recordingFetch();
    const result = await discoverEvidence({
      root,
      config: webConfig(['allowed.example']),
      fetch,
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: 'fd12:3456::1', family: 6 },
      ],
    });
    expect(requested).toEqual([]);
    expect(result.networkRequests).toBe(0);
  });

  it('refuses when the hostname cannot be resolved (fail closed)', async () => {
    const root = tempProject('dns-fail');
    writeFileSync(`${root}/README.md`, 'https://allowed.example/a');
    const { fetch, requested } = recordingFetch();
    const result = await discoverEvidence({
      root,
      config: webConfig(['allowed.example']),
      fetch,
      lookup: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    expect(requested).toEqual([]);
    expect(result.skipped).toContainEqual({
      source: 'https://allowed.example/a',
      reason: 'DNS lookup failed',
    });
  });

  it('fetches an allowlisted hostname resolving only to public addresses', async () => {
    const root = tempProject('dns-public');
    writeFileSync(`${root}/README.md`, 'https://allowed.example/a');
    const { fetch, requested } = recordingFetch();
    const result = await discoverEvidence({
      root,
      config: webConfig(['allowed.example']),
      fetch,
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      ],
    });
    expect(requested).toEqual(['https://allowed.example/a']);
    expect(result.networkRequests).toBe(1);
  });

  it('re-checks the final destination after a followed redirect against DNS', async () => {
    const root = tempProject('dns-redirect');
    writeFileSync(`${root}/README.md`, 'https://allowed.example/a');
    const resolved: Record<string, string> = {
      'allowed.example': '93.184.216.34',
      'internal.allowed.example': '10.0.0.5',
    };
    const result = await discoverEvidence({
      root,
      config: webConfig(['allowed.example']),
      fetch: async () => {
        const response = new Response('<p>The total must be at least 10.</p>');
        Object.defineProperty(response, 'url', { value: 'https://internal.allowed.example/secret' });
        return response;
      },
      lookup: async (hostname) => [{ address: resolved[hostname] ?? '127.0.0.1', family: 4 }],
    });
    expect(result.sources.some((source) => source.kind === 'web')).toBe(false);
    expect(result.skipped).toContainEqual({
      source: 'https://allowed.example/a',
      reason: 'redirect refused by allowlist or SSRF policy',
    });
  });
});

describe('SSRF: unsafe IP literal forms', () => {
  const unsafe = [
    '127.0.0.1',
    '127.1.2.3',
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '224.0.0.1',
    '255.255.255.255',
    '2130706433',
    '0x7f000001',
    '0177.0.0.1',
    '0x7f.1',
    '::1',
    '[::1]',
    '::',
    '::ffff:127.0.0.1',
    '[::ffff:7f00:1]',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '::7f00:1',
    '::127.0.0.1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'febf::1',
    'ff02::1',
    '64:ff9b::7f00:1',
    'localhost',
    'api.localhost',
  ];
  for (const host of unsafe)
    it(`treats ${host} as unsafe`, () => {
      expect(isUnsafeHost(host)).toBe(true);
    });
  for (const host of [
    '93.184.216.34',
    '172.32.0.1',
    '2606:2800:220:1:248:1893:25c8:1946',
    'docs.example.test',
  ])
    it(`treats ${host} as safe`, () => {
      expect(isUnsafeHost(host)).toBe(false);
    });

  it('never fetches IPv4-mapped, compatible, ULA, link-local, or numeric-form loopback URLs even when allowlisted', async () => {
    const root = tempProject('ip-literals');
    const urls = [
      'http://[::ffff:127.0.0.1]/a',
      'http://[::ffff:7f00:1]/b',
      'http://[::7f00:1]/c',
      'http://[fd00::1]/d',
      'http://[fe80::1]/e',
      'http://2130706433/f',
      'http://0x7f000001/g',
      'http://0177.0.0.1/h',
    ];
    writeFileSync(`${root}/README.md`, urls.join(' '));
    const { fetch, requested } = recordingFetch();
    const cfg = webConfig(['127.0.0.1', '2130706433', '0x7f000001']);
    // The config schema rejects IPv6 allowlist entries; inject them after parsing to prove the
    // SSRF check does not rely on the allowlist alone.
    cfg.sources.web.allowDomains.push(
      '::ffff:127.0.0.1',
      '[::ffff:7f00:1]',
      '[::7f00:1]',
      '[fd00::1]',
      '[fe80::1]',
    );
    const result = await discoverEvidence({
      root,
      config: cfg,
      fetch,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    expect(requested).toEqual([]);
    expect(result.networkRequests).toBe(0);
  });
});

describe('network request accounting', () => {
  it('counts a GitHub request whose fetch throws', async () => {
    const root = tempProject('github-throw');
    let calls = 0;
    const result = await discoverEvidence({
      root,
      config: VeritasConfig.parse({ sources: { github: { enabled: true, repo: 'acme/app' } } }),
      sources: ['github'],
      fetch: async () => {
        calls++;
        throw new TypeError('network down');
      },
    });
    expect(calls).toBe(1);
    expect(result.networkRequests).toBe(1);
    expect(result.skipped).toContainEqual({ source: 'github', reason: 'fetch failed' });
  });

  it('counts a web request whose fetch throws or times out', async () => {
    const root = tempProject('web-throw');
    writeFileSync(`${root}/README.md`, 'https://allowed.example/a https://allowed.example/slow');
    let calls = 0;
    const result = await discoverEvidence({
      root,
      config: config({
        web: {
          enabled: true,
          allowDomains: ['allowed.example'],
          maxPages: 10,
          maxDepth: 0,
          maxChars: 1000,
          timeoutMs: 5,
        },
      }),
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetch: async (input, init) => {
        calls++;
        if (String(input).endsWith('/a')) throw new TypeError('network down');
        await new Promise<void>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
        );
        return new Response('never');
      },
    });
    expect(calls).toBe(2);
    expect(result.networkRequests).toBe(2);
  });
});
