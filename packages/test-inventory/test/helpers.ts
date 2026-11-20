import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '../..');

export function copyFixture(name: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `veritas-${name}-`));
  cpSync(path.join(repoRoot, 'fixtures', name), root, { recursive: true });

  return root;
}

export function tempProject(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'veritas-inventory-'));

  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }

  return root;
}
