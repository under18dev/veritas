import { cpSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, type VeritasConfig } from '@under18dev/veritas-core';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURE = path.join(REPO_ROOT, 'fixtures', 'discount-boundary');

export function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), `veritas-mutation-${prefix}-`)));
}

/**
 * Copy the discount fixture outside the repository (mutator writes `.mutator/` into the project) and link
 * its installed dependencies, so vitest and mutator resolve exactly as in the fixture.
 */
export function copyDiscountFixture(): string {
  const dir = tempDir('fixture');
  cpSync(FIXTURE, dir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(FIXTURE, src);

      return rel !== 'node_modules' && rel !== '.mutator' && rel !== '.veritas';
    },
  });
  symlinkSync(path.join(FIXTURE, 'node_modules'), path.join(dir, 'node_modules'), 'dir');

  return dir;
}

export function config(mutation: Record<string, unknown> = {}): VeritasConfig {
  return parseConfig({ mutation }, null);
}
