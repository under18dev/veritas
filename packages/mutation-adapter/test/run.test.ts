import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { stableId, VeritasConfig } from '@under18dev/veritas-core';
import { vitestTestRunner as vitest } from '@under18dev/veritas-test-runner-vitest';
import { describe, expect, it } from 'vitest';
import {
  buildMutatorArgs,
  checkpointRestore,
  detectMutator,
  MutationRunResult,
  PINNED_MUTATOR_VERSION,
  runMutation,
  shellQuote,
  timeBudgetSeconds,
} from '../src/index.js';
import { config, copyDiscountFixture, tempDir } from './helpers.js';

const REAL_RUN_TIMEOUT = 120_000;
const weak = (name: string) => stableId('T', { file: 'test/discount-weak.test.ts', suitePath: [], name });
const shipping = (name: string) =>
  stableId('T', { file: 'test/shipping-boundary.test.ts', suitePath: [], name });

describe('buildMutatorArgs', () => {
  const base = {
    root: '/p',
    config: config({ timeoutMs: 60_000 }),
    reportDir: '/p/.veritas/runs/r/mutation',
  };

  it('passes root, both reporters, the report dir and the time budget', () => {
    expect(buildMutatorArgs(base)).toEqual([
      '--root',
      path.resolve('/p'),
      '--reporter',
      'json',
      '--reporter',
      'agent',
      '--report-dir',
      '/p/.veritas/runs/r/mutation',
      '--time-budget',
      '45',
    ]);
  });

  it('adds since, scope, kill matrix and only', () => {
    const args = buildMutatorArgs({
      ...base,
      since: 'origin/main',
      scope: ['src/**/*.ts', 'lib/a.ts'],
      killMatrix: true,
      only: ['e5rgni1gq2'],
    });
    expect(args.slice(8, -2)).toEqual([
      '--since',
      'origin/main',
      '--include',
      'src/**/*.ts',
      '--include',
      'lib/a.ts',
      '--kill-matrix',
      '--only',
      'e5rgni1gq2',
    ]);
  });

  it('caps the mutants per line only when asked, with a positive integer', () => {
    expect(buildMutatorArgs(base)).not.toContain('--mutants-per-line');
    expect(buildMutatorArgs({ ...base, mutantsPerLine: 2 })).toEqual(
      expect.arrayContaining(['--mutants-per-line', '2']),
    );

    for (const n of [0, -1, 1.5]) {
      expect(() => buildMutatorArgs({ ...base, mutantsPerLine: n })).toThrow(/invalid --mutants-per-line/);
    }
  });

  it('starts no new mutant earlier when asked, never later than 75% of the timeout', () => {
    const budget = (args: string[]) => args[args.indexOf('--time-budget') + 1];
    expect(budget(buildMutatorArgs({ ...base, timeBudgetSeconds: 30 }))).toBe('30');
    expect(budget(buildMutatorArgs({ ...base, timeBudgetSeconds: 600 }))).toBe('45');
    expect(budget(buildMutatorArgs({ ...base, timeBudgetSeconds: 0 }))).toBe('1');
  });

  it('rejects option injection and scopes outside the root', () => {
    expect(() => buildMutatorArgs({ ...base, since: '--output=/tmp/x' })).toThrow(/invalid git ref/);
    expect(() => buildMutatorArgs({ ...base, since: '' })).toThrow(/invalid git ref/);
    expect(() => buildMutatorArgs({ ...base, since: 'main extra' })).toThrow(/invalid git ref/);

    for (const glob of ['../secret/**', '/etc/**', '--config-file=evil.js', 'src/../../x', 'C:/x', '']) {
      expect(() => buildMutatorArgs({ ...base, scope: [glob] })).toThrow(/relative to the project root/);
    }

    for (const file of ['../x.ts', '/etc/x.ts', '--config=evil.js', '']) {
      expect(() => buildMutatorArgs({ ...base, exclude: [file] })).toThrow(/relative to the project root/);
    }
    expect(buildMutatorArgs({ ...base, exclude: ['src/a.ts'] })).toEqual(
      expect.arrayContaining(['--exclude', 'src/a.ts']),
    );

    for (const key of ['--plugin', 'a b', 'x;rm', '']) {
      expect(() => buildMutatorArgs({ ...base, only: [key] })).toThrow(/invalid mutant key/);
    }
  });
});

describe('timeBudgetSeconds', () => {
  it('keeps a quarter of the timeout to finish, and at least one second', () => {
    expect(timeBudgetSeconds(120_000)).toBe(90);
    expect(timeBudgetSeconds(1_333)).toBe(1);
    expect(timeBudgetSeconds(1)).toBe(1);
  });
});

describe('detectMutator', () => {
  it('finds the project installation first and reads its capabilities from --help', async () => {
    const root = copyDiscountFixture();
    const d = await detectMutator(root);
    expect(d).toMatchObject({ available: true, version: PINNED_MUTATOR_VERSION, origin: 'project' });
    expect(d.binPath).toMatch(/cli\.js$/);
    expect(d.capabilities).toEqual(
      expect.arrayContaining([
        '--root',
        '--reporter',
        '--report-dir',
        '--since',
        '--include',
        '--kill-matrix',
        '--only',
        '--time-budget',
        'agent',
        'json',
      ]),
    );
  });

  it('falls back to the adapter dependency and says so', async () => {
    const d = await detectMutator(tempDir('nomutator'));
    expect(d).toMatchObject({ available: true, origin: 'adapter' });
    expect(d.detail).toContain('adapter dependency');
  });

  it('reports unavailable when no mutator can be found', async () => {
    const d = await detectMutator(tempDir('nomutator'), { fallbackToAdapter: false });
    expect(d).toMatchObject({ available: false, binPath: null, version: null, capabilities: [] });
    expect(d.detail).toContain('not installed');
  });

  it('looks for the project mutator no higher than stopAt, so a package planted above a copy is not used', async () => {
    const parent = tempDir('shared-tmp');
    const root = path.join(parent, 'veritas-improve-copy');
    mkdirSync(root);
    // What a test (or another user of a shared temporary directory) could put next to the copy.
    const planted = path.join(parent, 'node_modules/@mizchi/mutator');
    mkdirSync(planted, { recursive: true });
    writeFileSync(
      path.join(planted, 'package.json'),
      '{"name":"@mizchi/mutator","version":"0.4.5","bin":"cli.js"}',
    );
    writeFileSync(path.join(planted, 'cli.js'), "console.log('--root --reporter --report-dir');\n");
    expect((await detectMutator(root)).binPath).toBe(path.join(planted, 'cli.js'));
    const confined = await detectMutator(root, { stopAt: root });
    expect(confined.origin).toBe('adapter');
    expect(confined.binPath).not.toContain(parent);
  });

  it('reports unavailable when the CLI lacks the required flags', async () => {
    const dir = tempDir('oldmutator');
    const bin = path.join(dir, 'cli.js');
    writeFileSync(bin, "console.log('usage: mutator [--watch]');\n");
    const d = await detectMutator(dir, { binPath: bin });
    expect(d.available).toBe(false);
    expect(d.detail).toMatch(/lacks required flags: --root, --reporter, --report-dir/);
  });
});

describe('runMutation failures', () => {
  it('is unsupported when the binary is missing', async () => {
    const root = tempDir('missing');
    const r = await runMutation({
      testRunner: vitest,
      root,
      config: config(),
      reportDir: path.join(root, 'out'),
      mutatorBin: path.join(root, 'nope', 'cli.js'),
    });
    expect(r.status).toBe('unsupported');
    expect(r.detail).toContain('not found');
    expect(r.command).toEqual([]);
    expect(r.mutants).toEqual([]);
    expect(MutationRunResult.parse(r)).toEqual(r);
  });

  it('is unsupported when the project has no mutator and fallback is disabled', async () => {
    const root = tempDir('missing');
    const r = await runMutation({
      testRunner: vitest,
      root,
      config: config(),
      reportDir: path.join(root, 'out'),
      projectMutatorOnly: true,
    });
    expect(r.status).toBe('unsupported');
    expect(r.backend).toEqual({ name: 'mizchi', version: null });
  });

  it('is unsupported on a Vitest older than 4, with the reason', async () => {
    const root = tempDir('oldvitest');
    mkdirSync(path.join(root, 'node_modules/vitest'), { recursive: true });
    writeFileSync(path.join(root, 'node_modules/vitest/package.json'), '{"name":"vitest","version":"3.2.4"}');
    const r = await runMutation({
      testRunner: vitest,
      root,
      config: config(),
      reportDir: path.join(root, 'out'),
    });
    expect(r.status).toBe('unsupported');
    expect(r.detail).toBe('mutation testing needs Vitest 4 or later; the project has Vitest 3.2.4');
    expect(r.command).toEqual([]);
    // Also when no test imports the code in scope.
    const none = await runMutation({
      testRunner: vitest,
      root,
      config: config(),
      reportDir: path.join(root, 'out'),
      testFiles: [],
    });
    expect(none.status).toBe('unsupported');
  });

  it('rejects a relative report dir and unsafe arguments before running anything', async () => {
    const root = tempDir('args');
    expect((await runMutation({ testRunner: vitest, root, config: config(), reportDir: 'out' })).status).toBe(
      'error',
    );
    const r = await runMutation({
      testRunner: vitest,
      root,
      config: config(),
      reportDir: path.join(root, 'o'),
      since: '-x',
    });
    expect(r).toMatchObject({ status: 'error', command: [] });
  });

  it('is cancelled when the signal is already aborted', async () => {
    const root = tempDir('abort');
    const r = await runMutation({
      testRunner: vitest,
      root,
      config: config(),
      reportDir: path.join(root, 'out'),
      signal: AbortSignal.abort(),
    });
    expect(r).toMatchObject({ status: 'cancelled', command: [] });
  });

  /** A stand-in CLI that advertises the real flags; used only to exercise report-handling errors. */
  function stubCli(body: string): { root: string; bin: string } {
    const root = tempDir('stub');
    const bin = path.join(root, 'stub-cli.js');
    writeFileSync(
      bin,
      [
        "const help = '--root --reporter json, agent --report-dir --since --include --kill-matrix --only --time-budget';",
        "if (process.argv.includes('--help')) { console.log(help); process.exit(0); }",
        "const fs = require('node:fs');",
        "const dir = process.argv[process.argv.indexOf('--report-dir') + 1];",
        body,
      ].join('\n'),
    );
    writeFileSync(path.join(root, 'package.json'), '{"type":"commonjs"}');

    return { root, bin };
  }

  it('is an error, keeping the raw report path, when mutation.json is unparsable', async () => {
    const { root, bin } = stubCli(
      "fs.writeFileSync(dir + '/mutation.json', '{not json'); console.log('{}');",
    );
    const reportDir = path.join(root, 'out');
    const r = await runMutation({ testRunner: vitest, root, config: config(), reportDir, mutatorBin: bin });
    expect(r.status).toBe('error');
    expect(r.rawReportPath).toBe(path.join(reportDir, 'mutation.json'));
    expect(r.detail).toMatch(/could not parse/);
    expect(r.mutants).toEqual([]);
  });

  it('in an isolated copy, is an error when mutator adopted verdicts planted during the run', async () => {
    // mutator opens its resume database after the dry run, which runs the tests: a test can plant verdicts there.
    const { root, bin } = stubCli(
      "console.error('dry run finished in 0.1s'); console.error('resumed 3/5 mutants from checkpoint, 2 left to run'); console.log('{}');",
    );
    const r = await runMutation({
      testRunner: vitest,
      root,
      config: config(),
      reportDir: path.join(root, 'out'),
      mutatorBin: bin,
      isolatedCopy: true,
    });
    expect(r.status).toBe('error');
    expect(r.detail).toMatch(/adopted 3 of 5 verdicts from a resume database in the isolated copy/);
  });

  it('recognises the resume line exactly as the installed mutator prints it', () => {
    // Pinned to mutator's own source, so an upgrade that rewords the line fails here instead of passing silently.
    const runJs = path.join(
      path.dirname(createRequire(import.meta.url).resolve('@mizchi/mutator')),
      'run.js',
    );
    const printed = `log(\`resumed \${resumed}/\${jobs.length} mutants from checkpoint, \${remaining.length} left to run\`)`;
    expect(readFileSync(runJs, 'utf8')).toContain(printed);
    expect(checkpointRestore({ stderr: 'x\nresumed 2/9 mutants from checkpoint, 7 left to run\n' })).toMatch(
      /adopted 2 of 9/,
    );
    expect(checkpointRestore({ stderr: '12 mutants, 12 to run\n' })).toBeNull();
    // A line printed by a test is no different, and a cut output cannot be checked.
    expect(checkpointRestore({ stderr: 'a'.repeat(10), stderrTail: 'done' })).toMatch(/too long to check/);
  });

  it('in an isolated copy, starts without mutator state or an old report left in the root', async () => {
    const { root, bin } = stubCli(
      "fs.writeFileSync(require('node:path').join(dir, '..', 'state-seen.txt'), String(fs.existsSync('.mutator'))); console.log('{}');",
    );
    const reportDir = path.join(root, 'out');
    // Forged resume state and a forged report, as a test running in the copy could leave them.
    mkdirSync(path.join(root, '.mutator/scopes'), { recursive: true });
    writeFileSync(path.join(root, '.mutator/scopes/snapshot.json.resume.sqlite'), 'forged');
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(path.join(reportDir, 'mutation.json'), '{"forged":true}');
    const r = await runMutation({
      testRunner: vitest,
      root,
      config: config(),
      reportDir,
      mutatorBin: bin,
      isolatedCopy: true,
    });
    expect(readFileSync(path.join(root, 'state-seen.txt'), 'utf8')).toBe('false');
    expect(existsSync(path.join(root, '.mutator'))).toBe(false);
    expect(r).toMatchObject({ status: 'error', rawReportPath: null });
    expect(r.detail).toMatch(/did not write/);
  });

  it('runs mutator with the heap limit of limits.memoryMb', async () => {
    const { root, bin } = stubCli(
      "fs.writeFileSync(dir + '/node-options.txt', process.env.NODE_OPTIONS ?? ''); console.log('{}');",
    );
    const reportDir = path.join(root, 'out');
    await runMutation({
      testRunner: vitest,
      root,
      config: VeritasConfig.parse({ limits: { memoryMb: 768 } }),
      reportDir,
      mutatorBin: bin,
    });
    expect(readFileSync(path.join(reportDir, 'node-options.txt'), 'utf8')).toContain(
      '--max-old-space-size=768',
    );
  });

  it('is an error when mutator exits 0 without writing a report', async () => {
    const { root, bin } = stubCli("console.log('{}');");
    const r = await runMutation({
      testRunner: vitest,
      root,
      config: config(),
      reportDir: path.join(root, 'out'),
      mutatorBin: bin,
    });
    expect(r).toMatchObject({ status: 'error', rawReportPath: null, exitCode: 0 });
    expect(r.detail).toMatch(/did not write/);
  });

  it('is an error on exit 1 and redacts secrets in the stderr summary', async () => {
    const { root, bin } = stubCli(
      "console.error('invalid option; token ghp_abcdefghijklmnopqrstuvwxyz0123456789'); process.exit(1);",
    );
    const r = await runMutation({
      testRunner: vitest,
      root,
      config: config(),
      reportDir: path.join(root, 'out'),
      mutatorBin: bin,
    });
    expect(r).toMatchObject({ status: 'error', exitCode: 1 });
    expect(r.detail).toContain('[REDACTED]');
    expect(r.detail).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });
});

describe('runMutation on the discount fixture (real mutator)', () => {
  it(
    'reports the surviving > to >= boundary mutant and the killed shipping mutants',
    async () => {
      const root = copyDiscountFixture();
      const reportDir = path.join(root, '.veritas', 'runs', 'r1', 'mutation');
      const r = await runMutation({ testRunner: vitest, root, config: config({ mode: 'full' }), reportDir });
      expect(r.detail).toBeNull();
      expect(r.status).toBe('succeeded');
      expect(MutationRunResult.parse(r)).toEqual(r);
      expect(r.backend).toEqual({ name: 'mizchi', version: '0.4.5' });
      expect(r.exitCode).toBe(0);
      expect(r.command.slice(0, 1)).toEqual([process.execPath]);
      expect(r.command.slice(2)).toEqual([
        '--root',
        root,
        '--reporter',
        'json',
        '--reporter',
        'agent',
        '--report-dir',
        reportDir,
        '--time-budget',
        '90',
      ]);
      expect(r.rawReportPath).toBe(path.join(reportDir, 'mutation.json'));
      expect(existsSync(path.join(reportDir, 'mutation.json'))).toBe(true);
      expect(r.agentReport).toMatchObject({ version: 1, scope: 'all' });
      expect(r.warnings).toEqual([]);

      expect(r.counts.killed).toBe(16);
      expect(r.counts.survived).toBe(1);
      expect(r.mutants).toHaveLength(17);
      expect(r.counts.equivalent_proven + r.counts.suspected_equivalent).toBe(0);

      const survived = r.mutants.filter((m) => m.status === 'survived');
      expect(survived).toHaveLength(1);
      const boundary = survived[0];
      expect(boundary).toMatchObject({
        location: { file: 'src/pricing.ts', range: { start: 3, end: 3 } },
        operator: 'EqualityOperator',
        original: 'total > 1000',
        replacement: 'total >= 1000',
        killedBy: [],
        relevance: 'unknown',
        propertyIds: [],
      });
      expect(boundary?.statusReason).toMatch(/not infected/);
      expect([...(boundary?.coveredBy ?? [])].sort()).toEqual(
        [weak('gives a discount on large orders'), weak('gives no discount on small orders')].sort(),
      );
      expect(boundary?.reproduction).toBe(
        `mutator --root ${shellQuote(root)} --only ${boundary?.backendKey}`,
      );

      const shippingBoundary = r.mutants.filter(
        (m) => m.location.range?.start === 11 && /total (>|<) 5000/.test(m.replacement),
      );
      expect(shippingBoundary.map((m) => m.replacement).sort()).toEqual(['total < 5000', 'total > 5000']);

      for (const m of shippingBoundary) {
        expect(m.status).toBe('killed');
        expect(m.killedBy.length).toBeGreaterThan(0);

        for (const t of m.killedBy) {
          expect([
            shipping('charges shipping just below the threshold'),
            shipping('ships free exactly at the threshold'),
          ]).toContain(t);
        }
      }
    },
    REAL_RUN_TIMEOUT,
  );

  it(
    'replays a single mutant with --only and returns the kill matrix when asked',
    async () => {
      const root = copyDiscountFixture();
      const first = await runMutation({
        testRunner: vitest,
        root,
        config: config(),
        reportDir: path.join(root, 'out1'),
      });
      const key = first.mutants.find((m) => m.status === 'survived')?.backendKey;
      expect(key).toBeDefined();
      const only = await runMutation({
        testRunner: vitest,
        root,
        config: config(),
        reportDir: path.join(root, 'out2'),
        only: [key as string],
        killMatrix: true,
      });
      expect(only.status).toBe('succeeded');
      expect(only.command).toContain('--kill-matrix');
      expect(only.mutants.find((m) => m.backendKey === key)?.status).toBe('survived');
      expect(only.killMatrix).not.toBeNull();
      expect(only.agentReport).toMatchObject({ selection: 'only' });
    },
    REAL_RUN_TIMEOUT,
  );

  it(
    'times out with a tiny timeout and reports no results',
    async () => {
      const root = copyDiscountFixture();
      const r = await runMutation({
        testRunner: vitest,
        root,
        config: config({ timeoutMs: 1 }),
        reportDir: path.join(root, 'out'),
      });
      expect(r.status).toBe('timeout');
      expect(r.mutants).toEqual([]);
      expect(r.counts.survived + r.counts.killed).toBe(0);
      expect(r.command.length).toBeGreaterThan(2);
    },
    REAL_RUN_TIMEOUT,
  );

  it(
    'is cancelled when aborted while running',
    async () => {
      const root = copyDiscountFixture();
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      const r = await runMutation({
        testRunner: vitest,
        root,
        config: config(),
        reportDir: path.join(root, 'out'),
        signal: controller.signal,
      });
      expect(r.status).toBe('cancelled');
      expect(r.mutants).toEqual([]);
    },
    REAL_RUN_TIMEOUT,
  );

  it(
    'fails with a stderr summary when the tests fail without mutants',
    async () => {
      const root = copyDiscountFixture();
      mkdirSync(path.join(root, 'test'), { recursive: true });
      writeFileSync(
        path.join(root, 'test', 'broken.test.ts'),
        "import { expect, it } from 'vitest';\nit('is broken', () => { expect(1).toBe(2); });\n",
      );
      const r = await runMutation({
        testRunner: vitest,
        root,
        config: config(),
        reportDir: path.join(root, 'out'),
      });
      expect(r).toMatchObject({ status: 'failed', exitCode: 4 });
      expect(r.detail).toMatch(/baseline/);
      // With the bundled copy, the detail says files from outside the project ran and how to avoid that.
      const ownCopy = r.warnings.some((w) => w.includes("adapter's own copy"));
      expect(/add @mizchi\/mutator to the project's devDependencies/.test(r.detail ?? '')).toBe(ownCopy);
      expect(r.mutants).toEqual([]);
    },
    REAL_RUN_TIMEOUT,
  );

  it(
    'warns when diff mode runs without a since ref',
    async () => {
      const root = copyDiscountFixture();
      const r = await runMutation({
        testRunner: vitest,
        root,
        config: config({ mode: 'diff' }),
        reportDir: path.join(root, 'out'),
        scope: ['src/pricing.ts'],
      });
      expect(r.status).toBe('succeeded');
      expect(r.warnings.join('\n')).toMatch(/no --since ref/);
      expect(r.mutants.every((m) => m.location.file === 'src/pricing.ts')).toBe(true);
    },
    REAL_RUN_TIMEOUT,
  );
});
