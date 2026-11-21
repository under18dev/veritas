import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { vitestTestRunner as vitest } from '@under18dev/veritas-test-runner-vitest';
import { describe, expect, it } from 'vitest';
import {
  buildMutatorArgs,
  MutationRunResult,
  mutatorProgress,
  runMutation,
  timeBudgetExhausted,
} from '../src/index.js';
import { config, tempDir } from './helpers.js';

/** A stand-in CLI that advertises the real flags, records its argv and runs `body`. */
function stubCli(body: string): { root: string; bin: string; argvFile: string } {
  const root = tempDir('typecheck-stub');
  const bin = path.join(root, 'stub-cli.js');
  const argvFile = path.join(root, 'argv.json');
  writeFileSync(
    bin,
    [
      "const help = '--root --reporter json, agent --report-dir --since --include --kill-matrix --only --[no-]typecheck --time-budget';",
      "if (process.argv.includes('--help')) { console.log(help); process.exit(0); }",
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));`,
      "const dir = process.argv[process.argv.indexOf('--report-dir') + 1];",
      body,
    ].join('\n'),
  );
  writeFileSync(path.join(root, 'package.json'), '{"type":"commonjs"}');

  return { root, bin, argvFile };
}

const SOURCE = 'export function f(a) {\n  return a > 10;\n}\n';
const mutant = (id: string, status: string) => ({
  id,
  mutatorName: 'EqualityOperator',
  replacement: 'a >= 10',
  location: { start: { line: 2, column: 10 }, end: { line: 2, column: 16 } },
  status,
  killedBy: [],
  coveredBy: [],
});
/** A report with one killed mutant and two that the time budget left pending. */
const REPORT = JSON.stringify({
  schemaVersion: '2',
  thresholds: { high: 80, low: 60 },
  files: {
    'src/f.ts': {
      language: 'javascript',
      source: SOURCE,
      mutants: [mutant('k1', 'Killed'), mutant('k2', 'Pending'), mutant('k3', 'Pending')],
    },
  },
});

const BASELINE = "console.error('dry run finished in 0.1s');";

describe('mutation.typecheck', () => {
  const base = { root: '/p', reportDir: '/p/.veritas/runs/r/mutation' };

  it('defaults to auto and passes --no-typecheck only when asked to', () => {
    expect(config().mutation.typecheck).toBe('auto');
    expect(buildMutatorArgs({ ...base, config: config() })).not.toContain('--no-typecheck');
    expect(buildMutatorArgs({ ...base, config: config(), noTypecheck: true })).toContain('--no-typecheck');
    expect(() => config({ typecheck: 'on' })).toThrow();
  });

  it('runs mutator with --no-typecheck when off, records it and warns about the counts', async () => {
    const { root, bin, argvFile } = stubCli(
      `${BASELINE} fs.writeFileSync(dir + '/mutation.json', ${JSON.stringify(REPORT.replace(/Pending/g, 'Survived'))}); console.log('{}');`,
    );
    const r = await runMutation({
      testRunner: vitest,
      root,
      config: config({ typecheck: 'off' }),
      reportDir: path.join(root, 'out'),
      mutatorBin: bin,
    });
    expect(r.status).toBe('succeeded');
    expect(MutationRunResult.parse(r)).toEqual(r);
    expect(JSON.parse(readFileSync(argvFile, 'utf8'))).toContain('--no-typecheck');
    expect(r.command).toContain('--no-typecheck');
    expect(r.typecheck).toBe('off');
    expect(r.warnings.join('\n')).toMatch(/mutation\.typecheck is "off": mutants were not type-checked/);
    expect(r.warnings.join('\n')).not.toMatch(/only references other projects/);
  });

  it('records auto and passes no typecheck flag by default', async () => {
    const { root, bin, argvFile } = stubCli(
      `${BASELINE} fs.writeFileSync(dir + '/mutation.json', ${JSON.stringify(REPORT.replace(/Pending/g, 'Survived'))}); console.log('{}');`,
    );
    const r = await runMutation({
      testRunner: vitest,
      root,
      config: config(),
      reportDir: path.join(root, 'out'),
      mutatorBin: bin,
    });
    expect(r.status).toBe('succeeded');
    expect(r.typecheck).toBe('auto');
    expect(JSON.parse(readFileSync(argvFile, 'utf8'))).not.toContain('--no-typecheck');
    expect(r.warnings.join('\n')).not.toMatch(/type-checked/);
  });
});

describe('a timeout before any mutant had finished', () => {
  const hang = 'setInterval(() => {}, 1000);';
  const timedOut = async (lines: string[], mutation: Record<string, unknown> = {}) => {
    const { root, bin } = stubCli(
      [...lines.map((l) => `console.error(${JSON.stringify(l)});`), hang].join('\n'),
    );
    const r = await runMutation({
      testRunner: vitest,
      root,
      config: config({ timeoutMs: 1500, ...mutation }),
      reportDir: path.join(root, 'out'),
      mutatorBin: bin,
    });
    expect(r.status).toBe('timeout');
    expect(r.mutants).toEqual([]);

    return r.detail ?? '';
  };

  it('blames type-checking, as most likely, when mutator had not printed its plan', async () => {
    const detail = await timedOut(['generated 12577 mutants', 'dry run finished in 0.1s']);
    expect(detail).toMatch(/no mutant had finished when it was killed/);
    expect(detail).toMatch(/most likely spent the time type-checking the mutants/);
    expect(detail).toMatch(/mutation\.typecheck to "off"/);
    expect(detail).toMatch(/--since <ref>/);
  }, 30_000);

  it('does not blame type-checking once mutator printed its plan of mutants to run', async () => {
    for (const plan of [
      ['120 mutants, 100 to run'],
      ['120 mutants, 100 to run (3 do not type-check)', 'estimated mutant execution: ~2m (4 sessions)'],
      [
        'estimated mutant execution: ~2m (4 sessions; 0/100 historical timings, remaining costs from dry run)',
      ],
    ]) {
      // The early type check alongside the dry run (with --since) says nothing about the main one.
      const detail = await timedOut([
        'typecheck (TypeScript 5.9.3): 40 mutants in 2.0s, alongside the dry run',
        'dry run finished in 0.1s',
        ...plan,
      ]);
      expect(detail).toMatch(/no mutant had finished when it was killed/);
      expect(detail).not.toMatch(/type-checking/);
      expect(detail).toMatch(/--since <ref>, or raise mutation\.timeoutMs/);
    }
  }, 60_000);

  it('does not blame type-checking when it was off', async () => {
    const detail = await timedOut(['dry run finished in 0.1s'], { typecheck: 'off' });
    expect(detail).toMatch(/no mutant had finished/);
    expect(detail).not.toMatch(/type-checking/);
  }, 30_000);

  it('adds no hint when a mutant had finished, the baseline failed or never finished', async () => {
    for (const lines of [
      ['dry run finished in 0.1s', '[1/12577] Killed   src/a.ts:3 a > b -> a >= b'],
      ['dry run finished in 0.1s', 'progress: 0/12577, elapsed 15s, eta 18h'],
      ['dry run finished in 0.1s', 'tests fail without mutants: test/a.test.ts'],
      [],
    ]) {
      expect(await timedOut(lines)).not.toMatch(/no mutant had finished/);
    }
  }, 60_000);
});

describe('an exhausted time budget', () => {
  const budgetRun = async (noise: string) => {
    const { root, bin } = stubCli(
      [
        BASELINE,
        noise,
        "console.error('[1/3] Killed   src/f.ts:2 a > 10 -> a >= 10');",
        "console.error('time budget of 45s exhausted: 2 mutants not run');",
        `fs.writeFileSync(dir + '/mutation.json', ${JSON.stringify(REPORT)});`,
        "console.log('{}');",
      ].join('\n'),
    );

    return runMutation({
      testRunner: vitest,
      root,
      config: config({ timeoutMs: 60_000 }),
      reportDir: path.join(root, 'out'),
      mutatorBin: bin,
      since: 'origin/main',
    });
  };

  it('records how many mutants were not run and suggests narrowing the run', async () => {
    const r = await budgetRun('');
    expect(r.status).toBe('succeeded');
    expect(MutationRunResult.parse(r)).toEqual(r);
    expect(r.timeBudgetExhausted).toEqual({ seconds: 45, notRun: 2 });
    expect(r.counts.pending).toBe(2);
    const warnings = r.warnings.join('\n');
    expect(warnings).toMatch(
      /time budget of 45s ran out \(75% of mutation\.timeoutMs, or of what was left of it .*\): 2 mutant\(s\) were not run.*partial.*--since <ref>, or raise mutation\.timeoutMs/,
    );
    // One message about the mutants not run, not a second generic one about pending mutants.
    expect(warnings).not.toMatch(/are pending/);
  });

  it('still finds the budget line after more stderr than the head buffer keeps', async () => {
    // 11 MiB of output before the last lines: more than the 10 MiB kept from the head of stderr.
    const r = await budgetRun(
      "const chunk = 'x'.repeat(1023) + '\\n'; for (let i = 0; i < 11 * 1024; i++) process.stderr.write(chunk);",
    );
    expect(r.timeBudgetExhausted).toEqual({ seconds: 45, notRun: 2 });
  }, 60_000);
});

describe('reading mutator progress', () => {
  it('tells the baseline, its failure, the plan and finished mutants apart', () => {
    expect(mutatorProgress('dry run finished in 21.4s\n')).toEqual({
      pastBaseline: true,
      baselineFailed: false,
      mutantsPlanned: false,
      mutantFinished: false,
    });
    expect(
      mutatorProgress(
        'dry run finished in 21.4s\n12577 mutants, 12000 to run\nprogress: 0/12000, elapsed 15s, eta 18h\n',
      ),
    ).toEqual({ pastBaseline: true, baselineFailed: false, mutantsPlanned: true, mutantFinished: true });
    expect(
      mutatorProgress('dry run finished in 0.1s\ntests fail without mutants: a.test.ts').baselineFailed,
    ).toBe(true);
    const colored = mutatorProgress(
      '\u001b[2mdry run finished in 1.0s\u001b[22m\n[3/9] Survived src/a.ts:1 x -> y',
    );
    expect(colored.pastBaseline).toBe(true);
    expect(colored.mutantFinished).toBe(true);
  });

  it('reads the exhausted time budget', () => {
    expect(
      timeBudgetExhausted('x\ntime budget of 450s exhausted: 11039 mutants not run\nreport written'),
    ).toEqual({ seconds: 450, notRun: 11039 });
    expect(timeBudgetExhausted('report written to out')).toBeNull();
  });
});
