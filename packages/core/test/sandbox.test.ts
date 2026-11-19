import { existsSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  callInSandbox,
  runCommand,
  sandboxBlocksNetwork,
  sandboxRefusal,
  sandboxRuntime,
} from '../src/index.js';

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

  it('blocks network on Node 25+ and reports that it does not on older versions', async () => {
    const { root, file } = project(
      'export function f() { return typeof process.permission?.has === "function" && process.permission.has("net"); }',
    );
    const result = await callInSandbox({
      root,
      modulePath: file,
      exportName: 'f',
      calls: [[]],
      timeoutMs: 20_000,
    });
    expect(result.status).toBe('ok');
    const major = Number(process.versions.node.split('.')[0]);
    // Both branches assert: CI runs this on Node 24 and on the current LTS.
    expect(result.isolation.network).toBe(major >= 25);
    if (major >= 25) expect(result.results[0]).toEqual({ t: 'boolean', v: false });
    else expect(sandboxBlocksNetwork()).toBe(false);
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

describe('runCommand timeouts', () => {
  it('kill the processes a command started, not only the command', async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-tree-')));
    const pidFile = path.join(dir, 'grandchild.pid');
    const script = path.join(dir, 'parent.mjs');
    writeFileSync(
      script,
      `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setInterval(() => {}, 1000);
`,
    );
    const result = await runCommand(process.execPath, [script], { cwd: dir, timeoutMs: 2_000 });
    expect(result.timedOut).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive()).toBe(false);
  }, 30_000);
});

describe('sandbox runtime', () => {
  const old = { node: '/old/node', version: '24.11.0' };

  it('refuses to run project code on a Node.js that cannot block network access', () => {
    const runtime = sandboxRuntime({ PATH: '' }, old);
    expect(runtime).toEqual({ node: '/old/node', version: '24.11.0', networkIsolated: false });
    expect(sandboxRefusal(runtime)).toMatch(/cannot block network access/);
    expect(sandboxRefusal(runtime, true)).toBeNull();
  });

  it('uses a newer Node.js from VERITAS_SANDBOX_NODE when this one is too old', () => {
    const runtime = sandboxRuntime({ PATH: '', VERITAS_SANDBOX_NODE: process.execPath }, old);
    expect(runtime.node).toBe(process.execPath);
    expect(runtime.networkIsolated).toBe(sandboxBlocksNetwork(process.versions.node));
    expect(sandboxRefusal(runtime)).toBe(runtime.networkIsolated ? null : sandboxRefusal(runtime));
  });

  it('ignores a VERITAS_SANDBOX_NODE that does not run', () => {
    const runtime = sandboxRuntime({ PATH: '', VERITAS_SANDBOX_NODE: '/no/such/node' }, old);
    expect(runtime.networkIsolated).toBe(false);
  });
});
