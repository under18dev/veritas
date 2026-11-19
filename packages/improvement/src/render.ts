import path from 'node:path';
import type { PatchFile, ProposedTest, ScalarValue } from './schema.js';

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function literal(value: ScalarValue): string {
  return typeof value === 'boolean' ? String(value) : String(BigInt(value));
}

/** ESM import specifier from the test file to the module, using the `.js` form TypeScript projects use. */
export function importSpecifier(testFile: string, module: string): string {
  const rel = path.posix
    .relative(path.posix.dirname(testFile), module)
    .replace(/\.(m|c)?tsx?$/, (ext) =>
      ext.startsWith('.m') ? '.mjs' : ext.startsWith('.c') ? '.cjs' : '.js',
    );
  return rel.startsWith('.') ? rel : `./${rel}`;
}

export function callText(test: ProposedTest): string {
  return `${test.exportName}(${test.params.map((p) => literal(test.input[p] as ScalarValue)).join(', ')})`;
}

/** Render one Vitest file for the tests of a single property. Every expected value is a spec-derived literal. */
export function renderTestFile(file: string, propertyId: string, tests: ProposedTest[]): string {
  const first = tests[0];
  if (!first) throw new Error('no test to render');
  if (!IDENTIFIER.test(first.exportName) || tests.some((t) => t.exportName !== first.exportName)) {
    throw new Error(`cannot render tests for export ${JSON.stringify(first.exportName)}`);
  }
  const citations = [...new Set(tests.flatMap((t) => t.citations))];
  const lines = [
    `// Added by \`veritas improve\` for property ${propertyId}.`,
    `// Expected values come from the specification${citations.length ? ` (${citations.join(', ')})` : ''}, not from the implementation.`,
    "import { expect, it } from 'vitest';",
    `import { ${first.exportName} } from ${JSON.stringify(importSpecifier(file, first.module))};`,
  ];
  for (const t of tests) {
    const call = callText(t);
    const why = t.origin === 'survived_mutant' ? 'distinguishes a surviving mutant' : 'boundary of the rule';
    lines.push(
      '',
      `it(${JSON.stringify(`${call} is ${literal(t.expected)} (${why})`)}, () => {`,
      `  expect(${call}).toBe(${literal(t.expected)});`,
      '});',
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Unified diff of new files against /dev/null. */
export function unifiedDiff(files: PatchFile[]): string {
  return files
    .map((f) => {
      const lines = f.content.endsWith('\n') ? f.content.slice(0, -1).split('\n') : f.content.split('\n');
      return [
        `--- /dev/null`,
        `+++ b/${f.path}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((l) => `+${l}`),
      ].join('\n');
    })
    .join('\n');
}
