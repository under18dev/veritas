import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { baselineFailure, errorExcerpt } from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Real mutator stderr (paths replaced) from a project whose bundler (vite:oxc) mis-parsed instrumented code. */
const OXC_STDERR = readFileSync(path.join(HERE, 'fixtures', 'oxc-parse-error.stderr.txt'), 'utf8');

describe('baselineFailure on a transform error', () => {
  const detail = baselineFailure(OXC_STDERR, '/repo');

  it("keeps mutator's summary and the parse error, not the middle of a stack trace", () => {
    expect(detail.startsWith('runner: vitest')).toBe(true);
    expect(detail).toContain(
      'tests fail without mutants: src/utils/__tests__/exportStyles.test.ts, src/components/__tests__/Preview.test.tsx',
    );
    expect(detail).toContain(
      'first error: src/utils/__tests__/exportStyles.test.ts: Transform failed with 5 errors:',
    );
    expect(detail).toContain('[PARSE_ERROR] HTML comments are not allowed in modules');
    expect(detail).toContain('in src/utils/exportStyles.ts at 34229..34233');
    expect(detail).not.toMatch(/^\s+at /m);
    expect(detail).not.toContain('node_modules');
  });

  it('drops terminal colors and repeated lines, and stays bounded', () => {
    expect(detail).not.toContain('\u001b');
    expect(detail.split('HTML comments are not allowed').length - 1).toBe(1);
    expect(detail.length).toBeLessThan(1200);
  });
});

describe('errorExcerpt', () => {
  it('keeps the head and the informative lines of a long output, without stack frames', () => {
    const text = [
      'Error: something broke',
      ...Array.from({ length: 40 }, (_, i) => `    at frame${i} (file:///x/node_modules/y.js:${i}:1)`),
      ...Array.from({ length: 30 }, (_, i) => `noise ${i}`),
      '  File: /p/src/a.ts',
    ].join('\n');
    const excerpt = errorExcerpt(text, 6, 400);
    expect(excerpt.split('\n')[0]).toBe('Error: something broke');
    expect(excerpt).toContain('File: /p/src/a.ts');
    expect(excerpt).not.toContain(' at frame');
    expect(excerpt.split('\n').length).toBeLessThanOrEqual(6);
  });

  it('cuts a long excerpt at the end, never at the start', () => {
    const excerpt = errorExcerpt(`Error: ${'x'.repeat(1000)}`, 5, 100);
    expect(excerpt.startsWith('Error: xxx')).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(101);
    expect(excerpt.endsWith('…')).toBe(true);
  });
});
