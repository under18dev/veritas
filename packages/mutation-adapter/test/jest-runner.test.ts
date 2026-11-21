import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { jestTestRunner as jest } from '@under18dev/veritas-test-runner-jest';
import { describe, expect, it } from 'vitest';
import { runMutation } from '../src/index.js';
import { config, tempDir } from './helpers.js';

function write(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), content);
  }
}

/** A stand-in mutator with --runner and --jest-config that records its arguments and kills one mutant. */
function recordingCli(dir: string): string {
  write(dir, {
    'package.json': '{"type":"commonjs"}',
    'stub-cli.js': [
      "const help = '--root --reporter json, agent --report-dir --include --config --runner --jest-config --[no-]typecheck --time-budget';",
      "if (process.argv.includes('--help')) { console.log(help); process.exit(0); }",
      "const fs = require('node:fs');",
      "const out = process.argv[process.argv.indexOf('--report-dir') + 1];",
      `fs.writeFileSync(${JSON.stringify(path.join(dir, 'argv.json'))}, JSON.stringify(process.argv.slice(2)));`,
      'const mutant = { id: "m1", mutatorName: "EqualityOperator", replacement: ">=", status: "Killed",',
      '  location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },',
      '  killedBy: ["test/a.test.ts#pricing gives a discount"], coveredBy: [] };',
      "fs.writeFileSync(out + '/mutation.json', JSON.stringify({ schemaVersion: '2', thresholds: { high: 80, low: 60 },",
      "  files: { 'src/a.ts': { language: 'typescript', source: 'x', mutants: [mutant] } } }));",
      "console.log('{}');",
    ].join('\n'),
  });

  return path.join(dir, 'stub-cli.js');
}

describe('mutation with the Jest provider', () => {
  it('runs mutator with --runner jest and --jest-config, warns that it is experimental and resolves test names', async () => {
    const root = tempDir('jest');
    const bin = recordingCli(tempDir('jest-cli'));
    write(root, {
      'package.json': '{"type":"module"}',
      'jest.config.mjs': 'export default {};',
      'src/a.ts': 'x',
    });
    const reportDir = path.join(root, '.veritas', 'runs', 'r', 'mutation');
    const tests = [
      { id: 'T-known', file: 'test/a.test.ts', suitePath: ['pricing'], name: 'gives a discount' },
    ];
    const result = await runMutation({
      root,
      config: config({ timeoutMs: 60_000 }),
      testRunner: jest,
      reportDir,
      mutatorBin: bin,
      testFiles: ['test/a.test.ts'],
      tests,
    });
    const argv = JSON.parse(readFileSync(path.join(path.dirname(bin), 'argv.json'), 'utf8')) as string[];

    expect(argv[argv.indexOf('--runner') + 1]).toBe('jest');
    expect(argv[argv.indexOf('--jest-config') + 1]).toBe(path.join(reportDir, 'jest.mutation.config.mjs'));
    expect(argv).not.toContain('--config');
    expect(result.status).toBe('succeeded');
    expect(result.warnings).toContain(
      `mutation testing with Jest is experimental: ${jest.mutation.experimental}`,
    );
    expect(result.mutants[0]?.killedBy).toEqual(['T-known']);
  });

  it('is unsupported, with the reason, outside native ESM projects', async () => {
    const root = tempDir('jest-cjs');
    write(root, { 'package.json': '{}', 'src/a.ts': 'x' });
    const result = await runMutation({
      root,
      config: config(),
      testRunner: jest,
      reportDir: path.join(root, '.veritas', 'runs', 'r', 'mutation'),
      mutatorBin: recordingCli(tempDir('jest-cli')),
    });

    expect(result.status).toBe('unsupported');
    expect(result.detail).toMatch(/native ESM projects/);
  });

  it('is unsupported when mutator has no --runner option', async () => {
    const root = tempDir('jest-old');
    const dir = tempDir('jest-old-cli');
    write(root, { 'package.json': '{"type":"module"}', 'src/a.ts': 'x' });
    write(dir, {
      'package.json': '{"type":"commonjs"}',
      'cli.js': "console.log('--root --reporter json, agent --report-dir --time-budget');",
    });
    const result = await runMutation({
      root,
      config: config(),
      testRunner: jest,
      reportDir: path.join(root, '.veritas', 'runs', 'r', 'mutation'),
      mutatorBin: path.join(dir, 'cli.js'),
    });

    expect(result.status).toBe('unsupported');
    expect(result.detail).toContain('--runner');
  });
});
