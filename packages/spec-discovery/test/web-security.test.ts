import { readdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { discoverEvidence } from '../src/index.js';
import { config, publicLookup, tempProject } from './helpers.js';

const webConfig = (extra: Record<string, unknown> = {}) =>
  config({
    web: {
      enabled: true,
      allowDomains: ['docs.example.test'],
      maxPages: 10,
      maxDepth: 1,
      maxChars: 1000,
      timeoutMs: 20,
      ...extra,
    },
  });

function seed(root: string, urls: string): void {
  writeFileSync(`${root}/README.md`, urls);
}

describe('web safety and budgets', () => {
  it('refuses redirects, private/loopback literals, and non-http schemes without fetching refused URLs', async () => {
    const root = tempProject('web-refusals');
    seed(
      root,
      'https://docs.example.test/redirect https://127.0.0.1/a https://10.0.0.1/b https://192.168.0.1/c http://[::1]/d ftp://docs.example.test/file file://docs.example.test/file',
    );
    const requested: string[] = [];
    const result = await discoverEvidence({
      root,
      lookup: publicLookup,
      config: webConfig(),
      fetch: async (input) => {
        requested.push(String(input));

        return new Response('', { status: 302, headers: { location: 'https://evil.test/' } });
      },
    });
    expect(requested).toEqual(['https://docs.example.test/redirect']);
    expect(result.skipped.filter((skip) => skip.reason.includes('refused')).length).toBeGreaterThanOrEqual(5);
  });

  it('allows subdomains, enforces maxDepth and maxChars, and aborts timed out pages', async () => {
    const root = tempProject('web-budgets');
    seed(root, 'https://sub.docs.example.test/root');
    const requested: string[] = [];
    const result = await discoverEvidence({
      root,
      lookup: publicLookup,
      config: webConfig({ maxDepth: 1, maxChars: 12, timeoutMs: 5 }),
      fetch: async (input, init) => {
        const url = String(input);
        requested.push(url);

        if (url.endsWith('/root'))
          return new Response('<p>The total must be at least 10.</p><a href="/child">child</a>');

        if (url.endsWith('/child')) return new Response('<a href="/grandchild">grandchild</a>');
        await new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });

        return new Response('never');
      },
    });
    expect(requested).toEqual(['https://sub.docs.example.test/root']);
    expect(result.sources.some((source) => source.locator.endsWith('/root'))).toBe(true);
    expect(
      result.sources.find((source) => source.locator.endsWith('/root'))?.summary.length,
    ).toBeLessThanOrEqual(200);
    expect(result.skipped.some((skip) => skip.reason.includes('character budget'))).toBe(true);

    const depthRoot = tempProject('web-depth');
    seed(depthRoot, 'https://sub.docs.example.test/root');
    const depthRequested: string[] = [];
    const depthResult = await discoverEvidence({
      root: depthRoot,
      lookup: publicLookup,
      config: webConfig({ maxDepth: 1, maxChars: 1000 }),
      fetch: async (input) => {
        const url = String(input);
        depthRequested.push(url);

        if (url.endsWith('/root')) return new Response('<a href="/child">child</a>');

        if (url.endsWith('/child')) return new Response('<a href="/grandchild">grandchild</a>');

        return new Response('grandchild');
      },
    });
    expect(depthRequested).toEqual([
      'https://sub.docs.example.test/root',
      'https://sub.docs.example.test/child',
    ]);
    expect(depthResult.sources.some((source) => source.locator.endsWith('/grandchild'))).toBe(false);

    const timeoutRoot = tempProject('web-timeout');
    seed(timeoutRoot, 'https://docs.example.test/slow');
    const timeout = await discoverEvidence({
      root: timeoutRoot,
      lookup: publicLookup,
      config: webConfig({ maxChars: 1000, timeoutMs: 5 }),
      fetch: async (_input, init) => {
        await new Promise<void>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
        );

        return new Response('never');
      },
    });
    expect(timeout.skipped).toContainEqual({
      source: 'https://docs.example.test/slow',
      reason: 'fetch timeout',
    });
    expect(readdirSync(timeoutRoot).sort()).toEqual(['README.md']);
  });
});

describe('web crawl limits', () => {
  it('times out a page whose body never finishes and reads no more of a body than the budget needs', async () => {
    const root = tempProject('web-body');
    seed(root, 'https://docs.example.test/slow https://docs.example.test/huge');
    let pulled = 0;
    const result = await discoverEvidence({
      root,
      lookup: publicLookup,
      config: webConfig({ maxDepth: 0, maxChars: 1000, timeoutMs: 50 }),
      fetch: async (input, init) => {
        if (String(input).endsWith('/slow'))
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('<p>partial</p>'));
                init?.signal?.addEventListener('abort', () =>
                  controller.error(new DOMException('aborted', 'AbortError')),
                );
              },
            }),
          );

        return new Response(
          new ReadableStream({
            pull(controller) {
              pulled++;
              controller.enqueue(new TextEncoder().encode('x'.repeat(1024)));
            },
          }),
        );
      },
    });
    expect(result.skipped).toContainEqual({
      source: 'https://docs.example.test/slow',
      reason: 'fetch timeout',
    });
    expect(result.sources.find((s) => s.locator.endsWith('/huge'))).toBeTruthy();
    expect(pulled).toBeLessThan(20);
  });

  it('stops the crawl when the total time budget is spent', async () => {
    const root = tempProject('web-deadline');
    seed(root, 'https://docs.example.test/a https://docs.example.test/b https://docs.example.test/c');
    const requested: string[] = [];
    const result = await discoverEvidence({
      root,
      lookup: publicLookup,
      config: webConfig({ maxDepth: 0, maxDurationMs: 30 }),
      fetch: async (input) => {
        requested.push(String(input));
        await new Promise((resolve) => setTimeout(resolve, 40));

        return new Response('<p>page</p>');
      },
    });
    expect(requested.length).toBeLessThan(3);
    expect(result.skipped).toContainEqual({ source: 'web', reason: 'time budget exhausted' });
  });

  it('counts DNS lookups against the crawl deadline', async () => {
    const root = tempProject('web-dns');
    seed(root, 'https://docs.example.test/a');
    let fetched = false;
    const started = Date.now();
    const result = await discoverEvidence({
      root,
      lookup: () => new Promise(() => {}),
      config: webConfig({ maxDepth: 0, maxDurationMs: 50 }),
      fetch: async () => {
        fetched = true;

        return new Response('<p>page</p>');
      },
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(fetched).toBe(false);
    expect(result.skipped).toContainEqual({
      source: 'https://docs.example.test/a',
      reason: 'DNS lookup timed out',
    });
  });

  it('reads only text documents and follows no links to stylesheets, scripts, images or fonts', async () => {
    const root = tempProject('web-content-type');
    seed(
      root,
      [
        'https://docs.example.test/guide',
        'https://docs.example.test/notes.md',
        'https://docs.example.test/served-as-css',
        'https://docs.example.test/served-as-js',
        'https://docs.example.test/logo',
      ].join(' '),
    );
    const requested: string[] = [];
    const types: Record<string, string> = {
      '/guide': 'text/html; charset=utf-8',
      '/notes.md': 'text/markdown',
      '/served-as-css': 'text/css',
      '/served-as-js': 'application/javascript',
      '/logo': 'image/png',
      '/child': 'text/html',
    };
    const result = await discoverEvidence({
      root,
      lookup: publicLookup,
      config: webConfig({ maxDepth: 1 }),
      fetch: async (input) => {
        const url = new URL(String(input));
        requested.push(url.pathname);
        const body =
          url.pathname === '/guide'
            ? [
                '<link rel="stylesheet" href="/_astro/Code.abc123.css">',
                '<script src="/_astro/page.js"></script>',
                '<p>The total must be at least 10.</p>',
                '<a href="/_astro/font.woff2">font</a>',
                '<a href="/img/shot.PNG?v=2">shot</a>',
                '<a href="/child">child</a>',
              ].join('')
            : url.pathname === '/served-as-css'
              ? '.a{color:red}.b{margin:0 auto}'
              : '<p>Retries must be at most 3.</p>';

        return new Response(body, { headers: { 'content-type': types[url.pathname] ?? 'text/css' } });
      },
    });
    expect(requested).toEqual(['/guide', '/notes.md', '/served-as-css', '/served-as-js', '/logo', '/child']);
    expect(result.sources.filter((s) => s.kind === 'web').map((s) => new URL(s.locator).pathname)).toEqual([
      '/guide',
      '/notes.md',
      '/child',
    ]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { source: 'https://docs.example.test/served-as-css', reason: 'not a text document (text/css)' },
        {
          source: 'https://docs.example.test/served-as-js',
          reason: 'not a text document (application/javascript)',
        },
        { source: 'https://docs.example.test/logo', reason: 'not a text document (image/png)' },
      ]),
    );
  });
});
