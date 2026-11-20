// Lists the workspace package directories under packages/ from the globs in pnpm-workspace.yaml
// (`packages/*`, `packages/llm-providers/*`, ...). Fixtures are not packages to publish.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** @returns {{ dir: string, manifest: Record<string, unknown> }[]} directories relative to the repository root */
export function workspacePackages(repo) {
  const globs = readFileSync(path.join(repo, 'pnpm-workspace.yaml'), 'utf8')
    .split('\n')
    .map((line) => line.match(/^\s+-\s+['"]?(packages\/[^'"*]*)\*['"]?\s*$/)?.[1])
    .filter(Boolean);
  const packages = [];

  for (const parent of globs) {
    for (const entry of readdirSync(path.join(repo, parent), { withFileTypes: true })) {
      const dir = `${parent}${entry.name}`;
      const file = path.join(repo, dir, 'package.json');

      if (entry.isDirectory() && existsSync(file))
        packages.push({ dir, manifest: JSON.parse(readFileSync(file, 'utf8')) });
    }
  }

  return packages;
}
