import { type TestCase, VeritasConfig } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import { selectMutationTestFiles } from '../src/index.js';

const test = (file: string, suspicions: TestCase['suspicions'] = []) => ({ file, suspicions }) as TestCase;

const inventory = {
  files: [
    { path: 'test/a.test.ts', hash: 'a', dependencies: ['src/a.ts', 'src/shared.ts'] },
    { path: 'test/b.test.ts', hash: 'b', dependencies: ['src/b.ts', 'test/helpers.ts'] },
    { path: 'test/standalone.test.ts', hash: 'c', dependencies: ['test/helpers.ts'] },
    { path: 'test/cli.test.ts', hash: 'd', dependencies: ['test/helpers.ts'] },
    { path: 'test/spawn.test.ts', hash: 'e', dependencies: ['src/b.ts'] },
    { path: 'test/alias.test.ts', hash: 'f', dependencies: ['src/b.ts'] },
  ],
  tests: [
    test('test/a.test.ts'),
    test('test/b.test.ts'),
    test('test/standalone.test.ts'),
    test('test/cli.test.ts', ['opaque_call']),
    test('test/spawn.test.ts', ['opaque_call']),
    test('test/alias.test.ts', ['unresolved_import']),
  ],
};

describe('selectMutationTestFiles', () => {
  const config = VeritasConfig.parse({});

  it('leaves out tests whose project sources are all outside the scope', () => {
    expect(selectMutationTestFiles(inventory, config, ['src/shared.ts'])).toEqual([
      'test/a.test.ts',
      'test/standalone.test.ts',
      'test/cli.test.ts',
      'test/spawn.test.ts',
      'test/alias.test.ts',
    ]);
  });

  it('keeps every test whose reach static analysis cannot see', () => {
    // A child process or dynamic import may load the mutated source itself (plain JavaScript, a TS loader),
    // and an unresolved import may be the source in scope: leaving them out could turn a kill into a survivor.
    const selected = selectMutationTestFiles(inventory, config, ['src/a.ts']);
    expect(selected).toContain('test/cli.test.ts');
    expect(selected).toContain('test/spawn.test.ts');
    expect(selected).toContain('test/alias.test.ts');
    expect(selected).not.toContain('test/b.test.ts');
  });

  it('does not count helpers in test directories as source, even when a broad include matches them', () => {
    const broad = VeritasConfig.parse({ analysis: { include: ['**/*.ts'] } });
    expect(selectMutationTestFiles(inventory, broad)).toContain('test/standalone.test.ts');
  });
});
