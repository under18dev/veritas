import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildMutatorArgs, MutationRunResult, runMutation } from '../src/index.js';
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
/** A report with one killed mutant and two survivors. */
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
