import { VeritasConfig } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import { inventoryTests } from '../src/index.js';
import { tempProject } from './helpers.js';

const shipping =
  'export function shippingCents(subtotalCents: number): number {\n  return subtotalCents > 50 ? 0 : 7;\n}\n';

function shippingTest(specifier: string, body = 'expect(shippingCents(51)).toBe(0);'): string {
  return `import { describe, expect, it } from 'vitest';
import { shippingCents } from '${specifier}';
describe('shipping', () => { it('ships free over threshold', () => { ${body} }); });
`;
}

function inventory(files: Record<string, string>) {
  return inventoryTests({ root: tempProject(files), config: VeritasConfig.parse({}) });
}

describe('module resolution without a tsconfig', () => {
  it('links a call through an extensionless relative import in an ESM package', () => {
    const result = inventory({
      'package.json': '{"type":"module"}',
      'src/shipping.ts': shipping,
      'test/shipping.test.ts': shippingTest('../src/shipping'),
    });
    const testCase = result.tests.at(0);

    if (!testCase) throw new Error('missing shipping test');

    expect(testCase.calledSymbols).toEqual(['src/shipping.ts#shippingCents']);
    expect(testCase.targetCalls.map((call) => call.asserted)).toEqual([true]);
    expect(testCase.suspicions).toEqual([]);
    expect(result.edges).toHaveLength(1);
  });

  it('still links a `.js` specifier to its `.ts` source', () => {
    const result = inventory({
      'package.json': '{"type":"module"}',
      'src/shipping.ts': shipping,
      'test/shipping.test.ts': shippingTest('../src/shipping.js'),
    });

    expect(result.tests.at(0)?.calledSymbols).toEqual(['src/shipping.ts#shippingCents']);
    expect(result.tests.at(0)?.suspicions).toEqual([]);
  });

  it('keeps flagging a constant assertion as tautological and disconnected', () => {
    const result = inventory({
      'src/shipping.ts': shipping,
      'test/shipping.test.ts': shippingTest('../src/shipping', 'expect(true).toBe(true);'),
    });

    expect(result.tests.at(0)?.suspicions).toEqual(['tautological_assertion', 'target_not_called']);
  });
});

describe('test file dependencies', () => {
  it('lists the local files a test file reaches through imports, and nothing outside the project', () => {
    const result = inventory({
      'src/a.ts': "import { b } from './b.js';\nexport const a = () => b();\n",
      'src/b.ts': "export const b = () => 1;\nexport type { Shape } from './types.js';\n",
      'src/types.ts': 'export type Shape = { x: number };\n',
      'src/unused.ts': 'export const unused = 1;\n',
      'test/a.test.ts': `import { expect, it } from 'vitest';
import path from 'node:path';
import { missing } from 'not-installed';
import { a } from '../src/a.js';
it('a', async () => { expect(a()).toBe(1); await import('../src/b.js'); path.sep; missing; });
`,
    });

    // src/types.ts is re-exported as a type only, which runs nothing.
    expect(result.files).toEqual([
      expect.objectContaining({
        path: 'test/a.test.ts',
        dependencies: ['src/a.ts', 'src/b.ts'],
      }),
    ]);
  });

  it('follows a barrel symbol by symbol, and counts whole what may run otherwise', () => {
    const dependencies = (test: string, extra: Record<string, string> = {}) =>
      inventory({
        'src/index.ts':
          "export { used } from './used.js';\nexport * from './star.js';\nexport { other } from './other.js';\n",
        'src/used.ts': "import { helper } from './helper.js';\nexport function used() { return helper(); }\n",
        'src/helper.ts': 'export const helper = () => 1;\n',
        'src/star.ts': 'export function starred() { return 2; }\n',
        'src/other.ts': 'export function other() { return 3; }\n',
        'src/effect.ts': "export const registry = new Map();\nregistry.set('x', 1);\n",
        'src/types.ts': 'export interface Shape { x: number }\n',
        'test/a.test.ts': `import { expect, it, vi } from 'vitest';\n${test}\n`,
        ...extra,
      }).files[0]?.dependencies;

    expect(
      dependencies("import { used } from '../src/index.js';\nit('a', () => { expect(used()).toBe(1); });"),
    ).toEqual(['src/helper.ts', 'src/used.ts']);
    expect(
      dependencies("import { starred } from '../src/index.js';\nit('a', () => { starred(); });"),
    ).toEqual(['src/star.ts']);
    expect(dependencies("import * as lib from '../src/index.js';\nit('a', () => { lib.other(); });")).toEqual(
      ['src/other.ts'],
    );
    // A namespace passed on may reach any export.
    expect(
      dependencies("import * as lib from '../src/index.js';\nit('a', () => { Object.keys(lib); });"),
    ).toEqual(['src/helper.ts', 'src/index.ts', 'src/other.ts', 'src/star.ts', 'src/used.ts']);
    expect(dependencies("import '../src/other.js';\nit('a', () => {});")).toEqual(['src/other.ts']);
    expect(
      dependencies(
        "import type { Shape } from '../src/types.js';\nimport { type Shape as S } from '../src/types.js';\nit('a', () => {});",
      ),
    ).toEqual([]);
    expect(
      dependencies(
        "vi.mock('../src/star.js');\nit('a', async () => { await vi.importActual('../src/other.js'); });",
      ),
    ).toEqual(['src/other.ts', 'src/star.ts']);
    // A module that runs code when loaded counts even when nothing it exports is used.
    expect(
      dependencies("import { used } from '../src/index.js';\nit('a', () => { used(); });", {
        'src/index.ts': "export { used } from './used.js';\nexport { registry } from './effect.js';\n",
      }),
    ).toEqual(['src/effect.ts', 'src/helper.ts', 'src/used.ts']);
  });
});

describe('module resolution that fails', () => {
  const nodenext = JSON.stringify({ compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext' } });

  it('marks a call through an unresolved relative import instead of claiming the target is not called', () => {
    const result = inventory({
      'package.json': '{"type":"module"}',
      'tsconfig.json': nodenext,
      'src/shipping.ts': shipping,
      'test/shipping.test.ts': shippingTest('../src/shipping'),
    });
    const testCase = result.tests.at(0);

    if (!testCase) throw new Error('missing shipping test');

    expect(testCase.calledSymbols).toEqual([]);
    expect(testCase.suspicions).toEqual(['unresolved_import']);
    expect(result.diagnostics.some((diagnostic) => diagnostic.file === 'test/shipping.test.ts')).toBe(true);
  });

  it('also marks namespace imports', () => {
    const result = inventory({
      'package.json': '{"type":"module"}',
      'tsconfig.json': nodenext,
      'src/shipping.ts': shipping,
      'test/shipping.test.ts': `import { expect, it } from 'vitest';
import * as shipping from '../src/shipping';
it('ships free over threshold', () => { expect(shipping.shippingCents(51)).toBe(0); });
`,
    });

    expect(result.tests.at(0)?.suspicions).toEqual(['unresolved_import']);
  });

  it('ignores unresolved bare specifiers such as an uninstalled test runner', () => {
    const result = inventory({
      'src/shipping.ts': shipping,
      'test/shipping.test.ts': `import { expect, it } from 'vitest';
import { helper } from 'not-installed';
it('uses a package', () => { expect(helper(1)).toBe(1); });
`,
    });

    expect(result.tests.at(0)?.suspicions).toEqual(['target_not_called']);
  });
});
