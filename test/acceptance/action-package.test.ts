import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const ACTION_DIR = path.join(REPO_ROOT, 'packages/github-action');

describe('the GitHub Action package', () => {
  const action = YAML.parse(readFileSync(path.join(ACTION_DIR, 'action.yml'), 'utf8')) as {
    inputs: Record<string, unknown>;
    outputs: Record<string, { value: string }>;
    runs: { using: string; steps: { id?: string; env?: Record<string, string>; run?: string }[] };
  };
  const step = action.runs.steps.find((s) => s.id === 'veritas');

  it('runs the published package of its own version', () => {
    const version = JSON.parse(readFileSync(path.join(ACTION_DIR, 'package.json'), 'utf8')).version as string;
    expect(action.runs.using).toBe('composite');
    expect(step?.run).toBe(`npx --yes @under18dev/veritas-github-action@${version}`);
  });

  it('passes every input to the program and maps every output it writes', () => {
    for (const name of Object.keys(action.inputs))
      expect(step?.env?.[`INPUT_${name.toUpperCase().replaceAll('-', '_')}`]).toBe(`\${{ inputs.${name} }}`);
    const main = readFileSync(path.join(ACTION_DIR, 'src/main.ts'), 'utf8');
    for (const key of ['verdict', 'exit-code', 'run-id', 'confirmed-findings', 'report-path', 'from-fork']) {
      // Written as an output key: `verdict:` or `'exit-code':`.
      expect(main).toMatch(new RegExp(`[\\s{]'?${key}'?: `));
      expect(action.outputs[key]?.value).toBe(`\${{ steps.veritas.outputs.${key} }}`);
    }
  });

  it('runs when started through a bin link, as npx does', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'veritas-action-bin-'));
    const link = path.join(dir, 'veritas-github-action');
    symlinkSync(path.join(ACTION_DIR, 'dist/main.js'), link);
    // Without a GitHub event the program refuses to run, which shows it ran at all.
    const result = spawnSync(process.execPath, [link], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '', GITHUB_WORKSPACE: dir },
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr.trim()).not.toBe('');
  });
});
