import { VeritasConfig } from '@veritas/core';
import { describe, expect, it } from 'vitest';
import { inventoryTests } from '../src/index.js';
import { tempProject } from './helpers.js';

describe('scope and diagnostics', () => {
  it('ignores files outside testInclude and does not crash on broken syntax', () => {
    const root = tempProject({
      'src/value.ts': 'export const value = (input: number) => input;\n',
      'test/included.test.ts': `import { expect, test } from 'vitest'; import { value } from '../src/value.js'; test('included', () => expect(value(1)).toBe(1));`,
      'test/ignored.ts': `import { test } from 'vitest'; test('ignored', () => {});`,
      'test/broken.test.ts': `import { test } from 'vitest'; test('broken', () => {`,
    });
    const inventory = inventoryTests({ root, config: VeritasConfig.parse({}) });

    expect(inventory.tests.map((test) => test.name)).toContain('included');
    expect(inventory.tests.map((test) => test.name)).not.toContain('ignored');
    expect(inventory.diagnostics.some((diagnostic) => diagnostic.file === 'test/broken.test.ts')).toBe(true);
  });

  it('does not treat node or Vitest calls as project symbols', () => {
    const root = tempProject({
      'src/value.ts': 'export const value = (input: number) => input;\n',
      'test/non-project.test.ts': `
        import { expect, test } from 'vitest';
        import path from 'node:path';
        test('non-project', () => { expect(path.basename('/x/y')).toBe('y'); });
      `,
    });
    const testCase = inventoryTests({ root, config: VeritasConfig.parse({}) }).tests.at(0);
    if (!testCase) throw new Error('missing non-project test');

    expect(testCase.calledSymbols).toEqual([]);
    expect(testCase.targetCalls).toEqual([]);
  });
});
