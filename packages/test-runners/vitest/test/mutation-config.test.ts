import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { projectViteUrl, vitestToolchain, writeMutationVitestConfig } from '../src/mutation-config.js';

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
  const list = (root: string, configPath: string) =>
    spawnSync(process.execPath, [vitestBin, 'list', '--filesOnly', '--config', configPath], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
    });
  const listFiles = (root: string, configPath: string): string[] => {
    const listed = list(root, configPath);
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

  // The Vitest installed with Veritas stands in for the project's.
  const toolchain = vitestToolchain(path.resolve(import.meta.dirname, '../../../..'));
  const mutationDir = (root: string) => {
    const dir = path.join(root, '.veritas/runs/r/mutation');
    mkdirSync(dir, { recursive: true });

    return dir;
  };

  it("finds the project's picomatch, tinyglobby and Vite through its Vitest", () => {
    expect(toolchain.picomatchUrl).toMatch(/^file:.*picomatch/);
    expect(toolchain.tinyglobbyUrl).toMatch(/^file:.*tinyglobby/);
    expect(toolchain.viteUrl).toMatch(/^file:.*vite/);
    expect(toolchain.vitestMajor).toBeGreaterThanOrEqual(4);
    expect(vitestToolchain(tempDir('no-vitest-toolchain'))).toEqual({
      viteUrl: null,
      picomatchUrl: null,
      tinyglobbyUrl: null,
      vitestMajor: null,
    });
  });

  it('matches include globs the way Vitest does, extglobs included', () => {
    const root = tempDir('extglob');
    write(root, {
      'vitest.config.mjs': `export default {
        test: {
          globals: true,
          projects: [
            { test: { name: 'main', globals: true, include: ['src/**/(*.)+(spec|test).+(ts|tsx|js|mjs)'] } },
            { test: { name: 'dom', globals: true, include: ['src/dom/**/(*.)+(spec|test).+(ts|tsx|js|mjs)'] } },
          ],
        },
      };`,
      'src/a.test.mjs': "it('a', () => {});",
      'src/b.test.mjs': "it('b', () => {});",
      'src/dom/c.test.mjs': "it('c', () => {});",
    });
    const configPath = writeMutationVitestConfig({
      root,
      dir: mutationDir(root),
      testFiles: ['src/a.test.mjs'],
      toolchain,
    });
    expectListed(root, configPath, ['src/a.test.mjs']);
  }, 90_000);

  it('narrows projects given as config file globs and directories, and drops those without a selected test', () => {
    const root = tempDir('string-projects');
    write(root, {
      'vitest.config.mjs': `export default {
        test: {
          globals: true,
          projects: [
            './runtime-tests/*/vitest.config.mjs',
            'packages/*',
            { test: { name: 'main', globals: true, include: ['src/**/*.test.mjs'] } },
          ],
        },
      };`,
      // Would fail if run: the projects that hold them must not be.
      'runtime-tests/node/vitest.config.mjs': "export default { test: { name: 'node', globals: true } };",
      'runtime-tests/node/index.test.mjs': "it('node', () => { throw new Error('not selected'); });",
      'runtime-tests/edge/vitest.config.mjs': "export default { test: { name: 'edge', globals: true } };",
      'runtime-tests/edge/index.test.mjs': "it('edge', () => { throw new Error('not selected'); });",
      // A directory project with its own config, and one without.
      'packages/a/vitest.config.mjs':
        "export default { test: { globals: true, include: ['test/**/*.test.mjs'] } };",
      'packages/a/package.json': '{ "name": "@scope/a" }',
      'packages/a/test/one.test.mjs': "it('one', () => {});",
      'packages/a/test/two.test.mjs': "it('two', () => {});",
      'packages/b/test/b.test.mjs': "import { it } from 'vitest'; it('b', () => {});",
      'src/main.test.mjs': "it('main', () => {});",
    });
    const configPath = writeMutationVitestConfig({
      root,
      dir: mutationDir(root),
      testFiles: ['packages/a/test/one.test.mjs', 'packages/b/test/b.test.mjs', 'src/main.test.mjs'],
      toolchain,
    });
    expectListed(root, configPath, [
      'packages/a/test/one.test.mjs',
      'packages/b/test/b.test.mjs',
      'src/main.test.mjs',
    ]);
    // A file project keeps its own name, or gets the one Vitest would give it.
    const listed = list(root, configPath);
    expect(listed.stdout).toContain('[@scope/a]');
    expect(listed.stdout).toContain('[b]');
  }, 90_000);

  it('fails with the reason when no project runs a selected test file', () => {
    const root = tempDir('none-selected');
    write(root, {
      'vitest.config.mjs': `export default {
        test: { projects: ['./runtime-tests/*/vitest.config.mjs', { test: { include: ['src/**/*.spec.mjs'] } }] },
      };`,
      'runtime-tests/node/vitest.config.mjs': "export default { test: { name: 'node' } };",
      'runtime-tests/node/index.test.mjs': "import { it } from 'vitest'; it('node', () => {});",
      'src/a.test.mjs': "import { it } from 'vitest'; it('a', () => {});",
    });
    const configPath = writeMutationVitestConfig({
      root,
      dir: mutationDir(root),
      testFiles: ['src/a.test.mjs'],
      toolchain,
    });
    const listed = list(root, configPath);
    expect(listed.status).not.toBe(0);
    expect(listed.stderr).toContain("the project's Vitest config runs none of them");
    // Without projects too.
    const flat = tempDir('none-selected-flat');
    write(flat, {
      'vitest.config.mjs': "export default { test: { include: ['test/**/*.spec.mjs'] } };",
      'test/a.test.mjs': "import { it } from 'vitest'; it('a', () => {});",
    });
    const flatConfig = writeMutationVitestConfig({
      root: flat,
      dir: mutationDir(flat),
      testFiles: ['test/a.test.mjs'],
      toolchain,
    });
    const flatListed = list(flat, flatConfig);
    expect(flatListed.status).not.toBe(0);
    expect(flatListed.stderr).toContain("the project's Vitest config runs none of them");
  }, 90_000);

  it('says so instead of guessing when a file project cannot be loaded', async () => {
    const root = tempDir('no-vite');
    write(root, {
      'vitest.config.mjs': "export default { test: { projects: ['packages/*'] } };",
      'packages/a/vitest.config.mjs': 'export default {};',
      'packages/a/a.test.mjs': '',
    });
    const configPath = writeMutationVitestConfig({
      root,
      dir: mutationDir(root),
      testFiles: ['packages/a/a.test.mjs'],
      toolchain: { ...toolchain, viteUrl: null },
    });
    await expect((await import(pathToFileURL(configPath).href)).default({})).rejects.toThrow(
      /cannot limit the Vitest project .*packages\/a\/vitest\.config\.mjs/,
    );
  });

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
