import { describe, expect, it } from 'vitest';
import { unreadTestFiles } from '../src/run.js';

const file = (path: string, fields: { unseenReach?: boolean; inexactNames?: 'open_collection' } = {}) => ({
  path,
  hash: 'h',
  dependencies: [],
  unseenReach: fields.unseenReach ?? false,
  ...(fields.inexactNames ? { inexactNames: fields.inexactNames } : {}),
});

describe('unreadTestFiles', () => {
  it('names the test files with no recorded test that static analysis could not read fully, with why', () => {
    const unread = unreadTestFiles({
      tests: [{ file: 'test/read.test.ts' } as never],
      edges: [],
      files: [
        file('test/read.test.ts', { inexactNames: 'open_collection' }),
        file('test/empty.test.ts'),
        file('test/loop.test.ts', { inexactNames: 'open_collection' }),
        file('test/dynamic.test.ts', { unseenReach: true }),
      ],
      diagnostics: [],
    });

    expect(unread).toEqual([
      'test/loop.test.ts (it runs code while its tests are collected that may register tests)',
      'test/dynamic.test.ts (it reaches code static analysis does not follow)',
    ]);
  });
});
