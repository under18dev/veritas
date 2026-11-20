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
  ],
  tests: [
    test('test/a.test.ts'),
    test('test/b.test.ts'),
    test('test/standalone.test.ts'),
    test('test/cli.test.ts', ['opaque_call']),
  ],
};

describe('selectMutationTestFiles', () => {
  const config = VeritasConfig.parse({});

  it('leaves out tests whose project sources are all outside the scope', () => {
    expect(selectMutationTestFiles(inventory, config, ['src/shared.ts'])).toEqual([
      'test/a.test.ts',
      'test/standalone.test.ts',
    ]);
    expect(selectMutationTestFiles(inventory, config, ['src/**'])).toEqual([
      'test/a.test.ts',
      'test/b.test.ts',
      'test/standalone.test.ts',
    ]);
  });

  it('does not count helpers in test directories as source, even when a broad include matches them', () => {
    const broad = VeritasConfig.parse({ analysis: { include: ['**/*.ts'] } });
    expect(selectMutationTestFiles(inventory, broad)).toEqual([
      'test/a.test.ts',
      'test/b.test.ts',
      'test/standalone.test.ts',
    ]);
  });

  it('keeps a test that imports no source, unless it only runs code out of process', () => {
    expect(selectMutationTestFiles(inventory, config)).toEqual([
      'test/a.test.ts',
      'test/b.test.ts',
      'test/standalone.test.ts',
    ]);
  });
});
