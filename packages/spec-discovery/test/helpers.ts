import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VeritasConfig } from '@veritas/core';

export const repoRoot = path.resolve(import.meta.dirname, '../../../');
export function tempProject(name = 'project'): string {
  return mkdtempSync(path.join(tmpdir(), `veritas-${name}-`));
}
export function fixture(name: string): string {
  const root = tempProject(name);
  cpSync(path.join(repoRoot, 'fixtures', name), root, { recursive: true });
  return root;
}
export function writeProjectFile(root: string, relative: string, content: string): void {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}
export function config(input: Record<string, unknown> = {}) {
  const { sources, web, github, local, ...rest } = input;
  return VeritasConfig.parse({
    ...rest,
    sources: {
      local: local ?? true,
      ...(sources as Record<string, unknown> | undefined),
      ...(web === undefined ? {} : { web }),
      ...(github === undefined ? {} : { github }),
    },
  });
}
