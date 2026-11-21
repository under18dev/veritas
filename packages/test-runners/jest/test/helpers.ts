import { cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/jest-app',
);

/**
 * Link every installed package to its real location. Linking the whole node_modules directory is not enough on
 * Windows: pnpm's relative links inside it would resolve against the junction instead of the real directory.
 */
function linkPackages(from: string, to: string): void {
  mkdirSync(to, { recursive: true });

  for (const entry of readdirSync(from)) {
    if (entry.startsWith('.')) continue;

    if (entry.startsWith('@')) linkPackages(path.join(from, entry), path.join(to, entry));
    else symlinkSync(realpathSync(path.join(from, entry)), path.join(to, entry), 'junction');
  }
}

/** A copy of the jest-app fixture outside the repository, with its installed packages linked. */
export function copyJestFixture(prefix: string): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), `veritas-${prefix}-`)));
  cpSync(FIXTURE, root, { recursive: true, filter: (src) => !src.includes('node_modules') });
  linkPackages(path.join(FIXTURE, 'node_modules'), path.join(root, 'node_modules'));

  return root;
}
