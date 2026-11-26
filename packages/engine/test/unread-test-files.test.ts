import { describe, expect, it } from 'vitest';
import { listUnreadTestFiles, unreadTestFiles } from '../src/run.js';

type Fields = {
  unseenReach?: boolean;
  inexactNames?: 'open_collection' | 'imported_registrations';
  usesRunner?: boolean;
  foreignRunner?: string;
  packageCall?: string;
};

const file = (path: string, fields: Fields = {}) => ({
  path,
  hash: 'h',
  dependencies: [],
  unseenReach: fields.unseenReach ?? false,
  ...(fields.inexactNames ? { inexactNames: fields.inexactNames } : {}),
  ...(fields.usesRunner !== undefined ? { usesRunner: fields.usesRunner } : {}),
  ...(fields.foreignRunner ? { foreignRunner: fields.foreignRunner } : {}),
  ...(fields.packageCall ? { packageCall: fields.packageCall } : {}),
});

const unreadOf = (files: ReturnType<typeof file>[]) =>
  unreadTestFiles({ tests: [{ file: 'test/read.test.ts' } as never], edges: [], files, diagnostics: [] });

describe('unreadTestFiles', () => {
  it('names the test files with no recorded test that static analysis could not read fully, with why', () => {
    const unread = unreadOf([
      file('test/read.test.ts', { inexactNames: 'open_collection' }),
      file('test/empty.test.ts'),
      file('test/loop.test.ts', { inexactNames: 'open_collection' }),
      file('test/dynamic.test.ts', { unseenReach: true }),
    ]);

    expect(unread).toEqual([
      'test/loop.test.ts (it runs code while its tests are collected that may register tests)',
      'test/dynamic.test.ts (it reaches code static analysis does not follow)',
    ]);
  });

  it('leaves out helpers that never use the runner, but not one whose imports register tests', () => {
    const unread = unreadOf([
      // `export { test } from 'node:test'`, or a helper with no runner call at all.
      file('test/support.ts', { inexactNames: 'open_collection', usesRunner: false }),
      file('test/fixtures.ts', { unseenReach: true, usesRunner: false }),
      file('test/shared.test.ts', { inexactNames: 'imported_registrations', usesRunner: false }),
      // It calls the runner in a way static analysis cannot read (`test[key](...)`).
      file('test/computed.test.ts', { inexactNames: 'open_collection', usesRunner: true }),
    ]);

    expect(unread).toEqual([
      'test/shared.test.ts (a module it imports registers its tests)',
      'test/computed.test.ts (it runs code while its tests are collected that may register tests)',
    ]);
  });

  it("says a file uses another runner's API instead of that it may register tests", () => {
    const unread = unreadOf([
      file('test/bun.test.ts', {
        inexactNames: 'open_collection',
        usesRunner: false,
        foreignRunner: 'bun:test',
      }),
      file('test/deno.test.ts', { usesRunner: false, foreignRunner: 'Deno.test' }),
    ]);

    expect(unread).toEqual([
      "test/bun.test.ts (it uses bun:test, the API of a test runner the project's test runner does not run)",
      "test/deno.test.ts (it uses Deno.test, the API of a test runner the project's test runner does not run)",
    ]);
  });

  it('names a file that calls into a package at its top level, even when it does not use the runner', () => {
    const unread = unreadOf([
      file('test/suite.test.ts', {
        inexactNames: 'open_collection',
        usesRunner: false,
        packageCall: 'some-lib',
      }),
      // A barrel or helper calling nothing at its top level stays out.
      file('test/barrel.test.ts', { inexactNames: 'open_collection', usesRunner: false }),
    ]);

    expect(unread).toEqual([
      'test/suite.test.ts (it calls into package some-lib at the top level and may register tests through it)',
    ]);
  });

  it('lists the first ten files in a message and counts the rest', () => {
    const many = Array.from({ length: 13 }, (_, index) => `f${index}`);

    expect(listUnreadTestFiles(many)).toBe(`${many.slice(0, 10).join('; ')}; and 3 more`);
    expect(listUnreadTestFiles(many.slice(0, 10))).toBe(many.slice(0, 10).join('; '));
  });
});
