import { existsSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  callInSandbox,
  runCommand,
  runProjectTests,
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
    // The Node.js that ran it may be newer than this one (VERITAS_SANDBOX_NODE); both outcomes assert something.
    const runtime = sandboxRuntime();
    expect(result.isolation.network).toBe(runtime.networkIsolated);
    expect(runtime.networkIsolated).toBe(sandboxBlocksNetwork(runtime.version));

    if (runtime.networkIsolated) expect(result.results[0]).toEqual({ t: 'boolean', v: false });
    else expect(sandboxRefusal(runtime)).toMatch(/cannot block network access/);
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
// A second descendant in its own process group, detached from this one.
const detached = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
detached.unref();
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([child.pid, detached.pid]));
setInterval(() => {}, 1000);
`,
    );
    const result = await runCommand(process.execPath, [script], { cwd: dir, timeoutMs: 2_000 });
    expect(result.timedOut).toBe(true);
    const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as number[];
    const alive = () =>
      pids.filter((pid) => {
        try {
          process.kill(pid, 0);

          return true;
        } catch {
          return false;
        }
      });

    for (let i = 0; i < 50 && alive().length > 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive()).toEqual([]);
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
    // The newest Node.js this machine offers (this one, or the one CI names in VERITAS_SANDBOX_NODE).
    const newer = sandboxRuntime();
    const runtime = sandboxRuntime({ PATH: '', VERITAS_SANDBOX_NODE: newer.node }, old);

    if (newer.networkIsolated) {
      expect(runtime).toEqual({ node: newer.node, version: newer.version, networkIsolated: true });
      expect(sandboxRefusal(runtime)).toBeNull();
    } else {
      expect(runtime.networkIsolated).toBe(false);
      expect(sandboxRefusal(runtime)).not.toBeNull();
    }
  });

  it('ignores a VERITAS_SANDBOX_NODE that does not run', () => {
    const runtime = sandboxRuntime({ PATH: '', VERITAS_SANDBOX_NODE: '/no/such/node' }, old);
    expect(runtime.networkIsolated).toBe(false);
  });
});

describe('runProjectTests', () => {
  it("gives project tests an empty temporary home instead of the user's, and removes it afterwards", async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-home-test-')));
    const result = await runProjectTests(
      process.execPath,
      [
        '-e',
        'const fs = require("node:fs"); console.log(JSON.stringify({ home: process.env.HOME, files: fs.readdirSync(process.env.HOME), profile: process.env.USERPROFILE }))',
      ],
      { cwd: dir, timeoutMs: 20_000 },
    );
    const seen = JSON.parse(result.stdout) as { home: string; files: string[]; profile: string };
    expect(seen.home).not.toBe(process.env.HOME);
    expect(seen.profile).toBe(seen.home);
    expect(seen.files).toEqual([]);
    expect(existsSync(seen.home)).toBe(false);
  });
});
