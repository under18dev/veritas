import { existsSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { callInSandbox, sandboxBlocksNetwork } from '../src/index.js';

function project(source: string): { root: string; file: string } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-sandbox-')));
  const file = path.join(root, 'mod.ts');
  writeFileSync(file, source);
  return { root, file };
}

describe('sandboxed execution', () => {
  it('calls a TypeScript export and encodes JS values exactly', async () => {
    const { root, file } = project(
      'export function f(x: number): number { if (x > 1000) { return 100; } return x === 0 ? -0 : x / 0; }',
    );
    const result = await callInSandbox({
      root,
      modulePath: file,
      exportName: 'f',
      calls: [[{ t: 'number', v: '1000' }], [{ t: 'number', v: '1001' }], [{ t: 'number', v: '0' }]],
      timeoutMs: 20_000,
    });
    expect(result.status, result.error ?? '').toBe('ok');
    expect(result.results).toEqual([
      { t: 'number', v: 'Infinity' },
      { t: 'number', v: '100' },
      { t: 'number', v: '-0' },
    ]);
  });

  it('reports thrown errors per call', async () => {
    const { root, file } = project(
      'export function f(x: number) { if (x < 0) throw new RangeError("neg"); return x; }',
    );
    const result = await callInSandbox({
      root,
      modulePath: file,
      exportName: 'f',
      calls: [[{ t: 'number', v: '-1' }]],
      timeoutMs: 20_000,
    });
    expect(result.results).toEqual([{ t: 'throw', v: 'RangeError: neg' }]);
  });

  it('denies file writes outside and inside the project', async () => {
    const { root, file } = project(
      'import { writeFileSync } from "node:fs";\nexport function f() { writeFileSync(' +
        JSON.stringify(path.join(tmpdir(), 'veritas-sandbox-escape.txt')) +
        ', "x"); return 1; }',
    );
    const result = await callInSandbox({
      root,
      modulePath: file,
      exportName: 'f',
      calls: [[]],
      timeoutMs: 20_000,
    });
    expect(result.results[0]?.t).toBe('throw');
    expect(existsSync(path.join(tmpdir(), 'veritas-sandbox-escape.txt'))).toBe(false);
  });

  it('denies child processes and eval', async () => {
    const { root, file } = project(
      'import { execSync } from "node:child_process";\nexport function a() { return execSync("echo hi").toString(); }\nexport function b() { return eval("1+1"); }',
    );
    const a = await callInSandbox({
      root,
      modulePath: file,
      exportName: 'a',
      calls: [[]],
      timeoutMs: 20_000,
    });
    const b = await callInSandbox({
      root,
      modulePath: file,
      exportName: 'b',
      calls: [[]],
      timeoutMs: 20_000,
    });
    expect(a.results[0]?.t).toBe('throw');
    expect(b.results[0]?.t).toBe('throw');
  });

  it('times out runaway code', async () => {
    const { root, file } = project('export function f() { for (;;) {} }');
    const result = await callInSandbox({
      root,
      modulePath: file,
      exportName: 'f',
      calls: [[]],
      timeoutMs: 1500,
    });
    expect(result.status).toBe('timeout');
  });

  it('blocks network on Node 25+', async () => {
    if (!sandboxBlocksNetwork()) return;
    const { root, file } = project('export function f() { return process.permission.has("net"); }');
    const result = await callInSandbox({
      root,
      modulePath: file,
      exportName: 'f',
      calls: [[]],
      timeoutMs: 20_000,
    });
    expect(result.isolation.network).toBe(true);
    expect(result.results[0]).toEqual({ t: 'boolean', v: false });
  });

  it('works when the project root is reached through a symlink', async () => {
    const { root, file } = project('export function f(x: number): number { return x + 1; }');
    const link = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-link-'))), 'proj');
    symlinkSync(root, link);
    const result = await callInSandbox({
      root: link,
      modulePath: path.join(link, path.basename(file)),
      exportName: 'f',
      calls: [[{ t: 'number', v: '1' }]],
      timeoutMs: 20_000,
    });
    expect(result.status, result.error ?? '').toBe('ok');
    expect(result.results).toEqual([{ t: 'number', v: '2' }]);
  });

  it('reports a missing export as an error, not a result', async () => {
    const { root, file } = project('export const g = 1;');
    const result = await callInSandbox({
      root,
      modulePath: file,
      exportName: 'f',
      calls: [[]],
      timeoutMs: 20_000,
    });
    expect(result.status).toBe('error');
  });
});
