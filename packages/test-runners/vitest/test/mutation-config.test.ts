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

  // The Vitest installed with Veritas stands in for the project's.
  const toolchain = vitestToolchain(path.resolve(import.meta.dirname, '../../../..'));

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
    const configPath = writeMutationVitestConfig({
      root,
      dir,
      testFiles: ['packages/a/test/a.test.mjs'],
      toolchain,
    });
    expectListed(root, configPath, ['packages/a/test/a.test.mjs']);
  }, 90_000);

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

  /** The config the generated one resolves to, without running Vitest. */
  const resolve = async (configPath: string, env = {}) =>
    (await import(`${pathToFileURL(configPath).href}?${Math.random()}`)).default(env) as Promise<{
      root: string;
      test: {
        include?: string[];
        projects?: { root?: string; test: { name?: string; include: string[] } }[];
      };
    }>;

  it("resolves a file project's own root and test.root from its directory, as Vitest does", () => {
    for (const [name, project] of [
      ['test-root', "{ test: { name: 'a', globals: true, root: 'src', setupFiles: ['./setup.mjs'] } }"],
      ['top-root', "{ root: 'src', test: { name: 'a', globals: true, setupFiles: ['./setup.mjs'] } }"],
    ] as const) {
      const root = tempDir(`file-root-${name}`);
      write(root, {
        'vitest.config.mjs': "export default { test: { projects: ['packages/*'] } };",
        'packages/a/vitest.config.mjs': `export default ${project};`,
        'packages/a/src/setup.mjs': 'globalThis.ready = true;',
        'packages/a/src/x.test.mjs':
          "it('x', () => { if (!globalThis.ready) throw new Error('no setup'); });",
        'packages/a/src/other.test.mjs': "it('other', () => {});",
      });
      const configPath = writeMutationVitestConfig({
        root,
        dir: mutationDir(root),
        testFiles: ['packages/a/src/x.test.mjs'],
        toolchain,
      });
      expectListed(root, configPath, ['packages/a/src/x.test.mjs']);
    }
  }, 90_000);

  it('takes the root of the project config from test.root too', async () => {
    const root = tempDir('test-root');
    write(root, {
      'vitest.config.mjs': "export default { test: { root: 'src', include: ['**/*.test.mjs'] } };",
      'src/s.test.mjs': "import { it } from 'vitest'; it('s', () => {});",
      'src/t.test.mjs': "import { it } from 'vitest'; it('t', () => {});",
    });
    const configPath = writeMutationVitestConfig({
      root,
      dir: mutationDir(root),
      testFiles: ['src/s.test.mjs'],
      toolchain,
    });
    expectListed(root, configPath, ['src/s.test.mjs']);
    const resolved = await resolve(configPath);
    expect(resolved.root).toBe(path.join(root, 'src'));
    expect(resolved.test.include).toEqual(['s.test.mjs']);
  }, 90_000);

  it('turns a project listed twice into one, and narrows the declaring config when it lists itself', async () => {
    const root = tempDir('dedupe');
    write(root, {
      'vitest.config.mjs': `export default {
        test: { name: 'root', globals: true, globalSetup: ['./gs.mjs'], include: ['test/**/*.test.mjs'], projects: ['.', 'packages/*', 'packages/a'] },
      };`,
      'packages/a/vitest.config.mjs': "export default { test: { name: 'a', globals: true } };",
      'gs.mjs': 'export default () => {};',
      'packages/a/a.test.mjs': "it('a', () => {});",
      'test/r.test.mjs': "it('r', () => {});",
      'test/s.test.mjs': "it('s', () => { throw new Error('not selected'); });",
    });
    const configPath = writeMutationVitestConfig({
      root,
      dir: mutationDir(root),
      testFiles: ['packages/a/a.test.mjs', 'test/r.test.mjs'],
      toolchain,
    });
    expectListed(root, configPath, ['packages/a/a.test.mjs', 'test/r.test.mjs']);
    const projects = (await resolve(configPath)).test.projects;
    expect(projects?.map((p) => p.test.name)).toEqual(['root', 'a']);
    // The root's globalSetup runs once for the run, not again as part of the root's own project.
    expect(projects?.[0]?.test.globalSetup).toBeUndefined();
  }, 90_000);

  it('treats negated include patterns as excludes, as tinyglobby does', async () => {
    const root = tempDir('negated');
    write(root, {
      'vitest.config.mjs':
        "export default { test: { projects: [{ test: { include: ['test/**/*.test.mjs', '!**/slow.test.mjs'] } }] } };",
      'test/fast.test.mjs': '',
      'test/slow.test.mjs': '',
    });
    const configPath = writeMutationVitestConfig({
      root,
      dir: mutationDir(root),
      testFiles: ['test/fast.test.mjs', 'test/slow.test.mjs'],
      toolchain,
    });
    expect((await resolve(configPath)).test.projects?.[0]?.test.include).toEqual(['test/fast.test.mjs']);
  });

  it('applies what an inline project inherits from the declaring config by the Vitest major', async () => {
    const root = tempDir('inherit');
    write(root, {
      'vitest.config.mjs':
        "export default { test: { exclude: ['src/skip/**'], projects: [{ test: { include: ['src/**/*.test.mjs'] } }] } };",
      'src/skip/a.test.mjs': '',
    });
    const write5 = writeMutationVitestConfig({
      root,
      dir: mutationDir(root),
      testFiles: ['src/skip/a.test.mjs'],
      toolchain: { ...toolchain, vitestMajor: 5 },
    });
    // Vitest 5 extends the declaring config by default, so its exclude applies.
    await expect(resolve(write5)).rejects.toThrow(/runs none of them/);
    const write4 = writeMutationVitestConfig({
      root,
      dir: mutationDir(root),
      testFiles: ['src/skip/a.test.mjs'],
      toolchain: { ...toolchain, vitestMajor: 4 },
    });
    expect((await resolve(write4)).test.projects?.[0]?.test.include).toEqual(['src/skip/a.test.mjs']);
  });

  it('cannot narrow a project that extends a config with its own include', async () => {
    const root = tempDir('extends-include');
    write(root, {
      'vitest.config.mjs':
        "export default { test: { projects: [{ extends: './shared.config.mjs', test: { name: 'x' } }] } };",
      'shared.config.mjs': "export default { test: { include: ['test/**/*.test.mjs'] } };",
      'test/a.test.mjs': '',
    });
    const configPath = writeMutationVitestConfig({
      root,
      dir: mutationDir(root),
      testFiles: ['test/a.test.mjs'],
      toolchain,
    });
    await expect(resolve(configPath)).rejects.toThrow(/cannot limit the Vitest project "x".*sets include/);
  });

  it("fails closed without the project's picomatch or tinyglobby", async () => {
    const root = tempDir('no-matcher');
    write(root, {
      'vitest.config.mjs': "export default { test: { projects: ['packages/*'] } };",
      'packages/a/vitest.config.mjs': 'export default {};',
      'packages/a/a.test.mjs': '',
    });
    const options = { root, dir: mutationDir(root), testFiles: ['packages/a/a.test.mjs'] };
    await expect(
      resolve(writeMutationVitestConfig({ ...options, toolchain: { ...toolchain, picomatchUrl: null } })),
    ).rejects.toThrow(/the picomatch of the project's Vitest, .* could not be loaded/);
    await expect(
      resolve(writeMutationVitestConfig({ ...options, toolchain: { ...toolchain, tinyglobbyUrl: null } })),
    ).rejects.toThrow(/the tinyglobby of the project's Vitest, .* could not be loaded/);
  });

  it('keeps an absolute root of a file project as it is', () => {
    for (const key of ['test.root', 'root'] as const) {
      const root = tempDir(`absolute-root-${key}`);
      const options = `name: 'c', globals: true, include: ['src/**/*.test.js']`;
      write(root, {
        'vitest.config.mjs': "export default { test: { projects: ['configs/vitest.config.mjs'] } };",
        'configs/vitest.config.mjs':
          key === 'root'
            ? `export default { root: ${JSON.stringify(root)}, test: { ${options} } };`
            : `export default { test: { root: ${JSON.stringify(root)}, ${options} } };`,
        'src/a.test.js': "it('a', () => {});",
        'src/b.test.js': "it('b', () => { throw new Error('not selected'); });",
      });
      const configPath = writeMutationVitestConfig({
        root,
        dir: mutationDir(root),
        testFiles: ['src/a.test.js'],
        toolchain,
      });
      expectListed(root, configPath, ['src/a.test.js']);
    }
  }, 90_000);

  it('leaves out the projects a negated pattern excludes, as Vitest does', async () => {
    const root = tempDir('negated-projects');
    write(root, {
      'vitest.config.mjs': "export default { test: { projects: ['packages/*', '!packages/excluded'] } };",
      'packages/a/vitest.config.mjs': "export default { test: { name: 'a', globals: true } };",
      'packages/a/a.test.mjs': "it('a', () => {});",
      'packages/excluded/vitest.config.mjs': "export default { test: { name: 'excluded', globals: true } };",
      'packages/excluded/x.test.mjs': "it('x', () => { throw new Error('excluded'); });",
    });
    const configPath = writeMutationVitestConfig({
      root,
      dir: mutationDir(root),
      testFiles: ['packages/a/a.test.mjs', 'packages/excluded/x.test.mjs'],
      toolchain,
    });
    expectListed(root, configPath, ['packages/a/a.test.mjs']);
    expect((await resolve(configPath)).test.projects?.map((p) => p.test.name)).toEqual(['a']);
  }, 90_000);

  it('keeps in-source candidates in includeSource, where Vitest checks them for import.meta.vitest', async () => {
    const root = tempDir('include-source');
    write(root, {
      'vitest.config.mjs':
        "export default { test: { globals: true, include: ['test/**/*.test.mjs'], includeSource: ['src/**/*.mjs'] } };",
      'src/helper.mjs': 'export const helper = 1;',
      'src/in-source.mjs':
        "export const one = 1;\nif (import.meta.vitest) { const { it } = import.meta.vitest; it('in source', () => {}); }\n",
      'test/a.test.mjs': "it('a', () => {});",
    });
    const configPath = writeMutationVitestConfig({
      root,
      dir: mutationDir(root),
      testFiles: ['src/helper.mjs', 'src/in-source.mjs', 'test/a.test.mjs'],
      toolchain,
    });
    expectListed(root, configPath, ['src/in-source.mjs', 'test/a.test.mjs']);
    const resolved = (await resolve(configPath)) as {
      test: { include?: string[]; includeSource?: string[] };
    };
    expect(resolved.test.include).toEqual(['test/a.test.mjs']);
    expect(resolved.test.includeSource).toEqual(['src/helper.mjs', 'src/in-source.mjs']);
  }, 90_000);

  it('substitutes <rootDir> in project entries', async () => {
    const root = tempDir('rootdir');
    write(root, {
      'vitest.config.mjs': "export default { test: { projects: ['<rootDir>/packages/*'] } };",
      'packages/a/vitest.config.mjs': "export default { test: { name: 'a' } };",
      'packages/a/a.test.mjs': '',
    });
    const configPath = writeMutationVitestConfig({
      root,
      dir: mutationDir(root),
      testFiles: ['packages/a/a.test.mjs'],
      toolchain,
    });
    expect((await resolve(configPath)).test.projects?.map((p) => p.test.include)).toEqual([['a.test.mjs']]);
  });

  it('works without a project config', () => {
    const root = tempDir('bare');
    write(root, {
      'test/a.test.mjs': "import { it } from 'vitest'; it('a', () => {});",
      'test/b.test.mjs': "import { it } from 'vitest'; it('b', () => {});",
    });
    const dir = path.join(root, '.veritas/runs/r/mutation');
    mkdirSync(dir, { recursive: true });
    const configPath = writeMutationVitestConfig({ root, dir, testFiles: ['test/b.test.mjs'], toolchain });
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
