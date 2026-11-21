import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  callInSandbox,
  type LogEvent,
  logEvent,
  nodeMemoryFlags,
  outOfMemory,
  runCommand,
  runProjectTests,
  traceCollector,
  withRunContext,
} from '../src/index.js';

const tmp = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-ctx-')));

describe('run context', () => {
  it('sends redacted events to every sink of the current and enclosing contexts, and nowhere outside', async () => {
    const outer: LogEvent[] = [];
    const inner: LogEvent[] = [];
    logEvent('info', 'nobody listens');
    await withRunContext({ sinks: [(e) => outer.push(e)] }, () =>
      withRunContext({ sinks: [(e) => inner.push(e)] }, async () => {
        logEvent('debug', 'token ghp_abcdefghijklmnopqrstuvwxyz', {
          header: 'Bearer sk-ant-abcdefghijklmnopqrst',
        });
      }),
    );
    expect(inner).toHaveLength(1);
    expect(outer).toEqual(inner);
    expect(JSON.stringify(inner)).not.toMatch(/ghp_|sk-ant-/);
    expect(inner[0]).toMatchObject({ level: 'debug' });
  });

  it('records each child process with its outcome and a cwd relative to the root', async () => {
    const root = tmp();
    const events: LogEvent[] = [];
    await withRunContext({ root, sinks: [(e) => events.push(e)] }, () =>
      runCommand(process.execPath, ['-e', 'process.exit(3)'], { cwd: root, timeoutMs: 20_000 }),
    );
    expect(events).toEqual([
      expect.objectContaining({ event: 'process-start', cwd: '.', level: 'debug' }),
      expect.objectContaining({ event: 'process', cwd: '.', exitCode: 3, timedOut: false, level: 'debug' }),
    ]);
  });

  it('sends output lines as events only when asked, without terminal escapes', async () => {
    const root = tmp();
    const script = "process.stdout.write('one\\n\\u001b[32mtwo\\u001b[0m\\n'); process.stderr.write('three')";
    const run = async (logOutput: boolean) => {
      const events: LogEvent[] = [];
      await withRunContext({ root, sinks: [(e) => events.push(e)] }, () =>
        runCommand(process.execPath, ['-e', script], { cwd: root, timeoutMs: 20_000, logOutput }),
      );

      return events.filter((e) => e.event === 'process-output').map((e) => [e.stream, e.message]);
    };
    expect(await run(false)).toEqual([]);
    expect(await run(true)).toEqual([
      ['stdout', expect.stringMatching(/: one$/)],
      ['stdout', expect.stringMatching(/: two$/)],
      ['stderr', expect.stringMatching(/: three$/)],
    ]);
  });

  it('never writes a trace larger than its cap in UTF-8 bytes, truncation line included', () => {
    const trace = traceCollector(1000);

    for (let i = 0; i < 50; i++)
      trace.sink({ time: 't', level: 'debug', message: `事象 ${i} ${'あ'.repeat(30)}` });
    const text = trace.text();
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1000);
    expect(text).toMatch(/later event\(s\) were dropped/);
  });

  it('stays within even a tiny cap', () => {
    for (const cap of [100, 200]) {
      const trace = traceCollector(cap);

      for (let i = 0; i < 10; i++) trace.sink({ time: 't', level: 'debug', message: `event ${i}` });
      expect(Buffer.byteLength(trace.text(), 'utf8')).toBeLessThanOrEqual(cap);
    }
  });

  it('keeps a bounded trace and says how many events it dropped', () => {
    const trace = traceCollector(400);

    for (let i = 0; i < 20; i++) trace.sink({ time: 't', level: 'debug', message: `event ${i}` });
    const lines = trace.text().trim().split('\n');
    expect(lines.length).toBeLessThan(20);
    expect(JSON.parse(lines.at(-1) as string).message).toMatch(
      /trace truncated at 400 bytes; \d+ later event/,
    );
  });
});

describe('memory limits', () => {
  it('gives project test runs the memory limit through NODE_OPTIONS, and nothing else from the user', async () => {
    const root = tmp();
    const run = (memoryMb?: number) =>
      runProjectTests(process.execPath, ['-e', 'process.stdout.write(process.env.NODE_OPTIONS ?? "none")'], {
        cwd: root,
        timeoutMs: 20_000,
        ...(memoryMb ? { memoryMb } : {}),
      });
    expect((await run(512)).stdout).toBe('--max-old-space-size=512');
    expect((await run()).stdout).toBe('none');
    expect(await withRunContext({ memoryMb: 768 }, () => run().then((r) => r.stdout))).toBe(
      '--max-old-space-size=768',
    );
    expect(nodeMemoryFlags(1024)).toEqual(['--max-old-space-size=1024']);
    expect(
      outOfMemory('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'),
    ).toBe(true);
  });

  it('reports a sandboxed call that runs out of memory as an error, never a result', async () => {
    const root = tmp();
    const file = path.join(root, 'grow.ts');
    writeFileSync(
      file,
      'export function grow(n: number): number { const keep: number[][] = []; for (;;) keep.push(new Array(1_000_000).fill(n)); }\n',
    );
    const result = await callInSandbox({
      root,
      modulePath: file,
      exportName: 'grow',
      calls: [[{ t: 'number', v: '1' }]],
      timeoutMs: 60_000,
      memoryMb: 32,
      allowNetworkWithoutIsolation: true,
    });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/ran out of memory \(limit 32 MiB/);
  }, 90_000);
});
