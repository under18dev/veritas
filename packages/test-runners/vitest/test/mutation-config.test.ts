import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { projectViteUrl, writeMutationVitestConfig } from '../src/mutation-config.js';

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), `veritas-vitest-runner-${prefix}-`)));
}

function write(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), content);
  }
}

describe('writeMutationVitestConfig', () => {
  const vitestBin = path.join(
    path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
    'vitest.mjs',
  );
  const listFiles = (root: string, configPath: string): string[] => {
    const listed = spawnSync(process.execPath, [vitestBin, 'list', '--filesOnly', '--config', configPath], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(listed.status, listed.stderr).toBe(0);

    return listed.stdout
      .split('\n')
      .map((line) =>
        line
          .replace(/^\[[^\]]*\]\s*/, '')
          .trim()
          .split('\\')
          .join('/'),
      )
      .filter(Boolean)
      .sort();
  };

  // Vitest prints paths relative to its own view of the root, which on Windows may differ from ours in
  // 8.3 short names (RUNNER~1 vs runneradmin), so compare by the path inside the project.
  const expectListed = (root: string, configPath: string, expected: string[]) => {
    const listed = listFiles(root, configPath);

    expect(listed).toHaveLength(expected.length);

    for (const [i, file] of expected.entries())
      expect(listed[i] === file || listed[i]?.endsWith(`/${file}`), `${listed[i]} is ${file}`).toBe(true);
  };

  it('keeps only the selected tests in the project config and drops projects left without one', () => {
    const root = tempDir('narrow');
    write(root, {
      'vitest.config.mjs': `export default {
        test: {
          globals: true,
          projects: [
            { test: { name: 'unit', globals: true, include: ['packages/*/test/**/*.test.mjs'] } },
            { test: { name: 'acceptance', globals: true, include: ['test/acceptance/**/*.test.mjs'] } },
          ],
        },
      };`,
      'packages/a/test/a.test.mjs': "it('a', () => {});",
      'packages/b/test/b.test.mjs': "it('b', () => {});",
      'test/acceptance/slow.test.mjs': "it('slow', () => {});",
    });
    const dir = path.join(root, '.veritas/runs/r/mutation');
    mkdirSync(dir, { recursive: true });
    const configPath = writeMutationVitestConfig({ root, dir, testFiles: ['packages/a/test/a.test.mjs'] });
    expectListed(root, configPath, ['packages/a/test/a.test.mjs']);
  }, 90_000);

  it('works without a project config', () => {
    const root = tempDir('bare');
    write(root, {
      'test/a.test.mjs': "import { it } from 'vitest'; it('a', () => {});",
      'test/b.test.mjs': "import { it } from 'vitest'; it('b', () => {});",
    });
    const dir = path.join(root, '.veritas/runs/r/mutation');
    mkdirSync(dir, { recursive: true });
    const configPath = writeMutationVitestConfig({ root, dir, testFiles: ['test/b.test.mjs'] });
    expect(readFileSync(configPath, 'utf8')).toContain('const baseModule = {};');
    expectListed(root, configPath, ['test/b.test.mjs']);
  }, 90_000);

  it("allows the bundled mutator's files next to Vite's default, keeping every test without testFiles", async () => {
    const root = tempDir('allow');
    write(root, {
      'vitest.config.mjs': 'export default { test: { include: ["test/**/*.test.mjs"] } };',
      'test/a.test.mjs': "import { it } from 'vitest'; it('a', () => {});",
      'test/b.test.mjs': "import { it } from 'vitest'; it('b', () => {});",
    });
    const dir = path.join(root, '.veritas/runs/r/mutation');
    mkdirSync(dir, { recursive: true });
    const outside = tempDir('mutator-vitest');
    // The Vite installed with Veritas stands in for the project's.
    const viteUrl = projectViteUrl(path.resolve(import.meta.dirname, '../../../..'));
    expect(viteUrl).toMatch(/^file:.*vite/);
    const configPath = writeMutationVitestConfig({ root, dir, fsAllow: { dirs: [outside], viteUrl } });
    expectListed(root, configPath, ['test/a.test.mjs', 'test/b.test.mjs']);
    const resolved = await (await import(pathToFileURL(configPath).href)).default({});
    expect(resolved.test.include).toEqual(['test/**/*.test.mjs']);
    expect(resolved.server.fs.allow).toHaveLength(2);
    expect(resolved.server.fs.allow[1]).toBe(outside);
    // A project's own allow list is kept and extended.
    const project = tempDir('own-allow');
    write(project, { 'vitest.config.mjs': 'export default { server: { fs: { allow: ["/shared"] } } };' });
    const own = writeMutationVitestConfig({
      root: project,
      dir: project,
      fsAllow: { dirs: [outside], viteUrl: null },
    });
    const extended = await (await import(pathToFileURL(own).href)).default({});
    expect(extended.server.fs.allow).toEqual(['/shared', outside]);
    expect(projectViteUrl(tempDir('no-vitest'))).toBeNull();
  }, 90_000);
});
