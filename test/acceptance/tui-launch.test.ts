import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CLI } from './helpers.js';

describe('veritas without arguments', () => {
  const env = { ...process.env, CI: '' };

  it('prints help and exits 2 when the output is not a terminal, as before', () => {
    const result = spawnSync(process.execPath, [CLI], {
      encoding: 'utf8',
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Usage: veritas');
    expect(result.stderr).toContain('without arguments in an interactive terminal');
  });

  it('keeps stdout pure JSON with --json', () => {
    const result = spawnSync(process.execPath, [CLI, '--json'], { encoding: 'utf8', env });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'error', code: 'USAGE' });
  });
});
