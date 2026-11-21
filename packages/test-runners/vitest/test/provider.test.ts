import { selectTestRunner, VeritasConfig } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import { vitestTestRunner } from '../src/index.js';

describe('vitestTestRunner', () => {
  it('is selected by the default analysis.testFramework', () => {
    const framework = VeritasConfig.parse({}).analysis.testFramework;

    expect(selectTestRunner([vitestTestRunner], framework)).toBe(vitestTestRunner);
    expect(() => selectTestRunner([], framework)).toThrow(/no test runner provider/);
  });

  it('writes the imports and assertions of generated tests', () => {
    expect(vitestTestRunner.templates(process.cwd()).imports(['it', 'describe'])).toEqual([
      "import { describe, it } from 'vitest';",
    ]);
    expect(vitestTestRunner.templates(process.cwd()).imports(['it', 'expect', 'it'])).toEqual([
      "import { expect, it } from 'vitest';",
    ]);
    expect(vitestTestRunner.templates(process.cwd()).imports([])).toEqual([]);
    expect(vitestTestRunner.templates(process.cwd()).expectToBe('f(1n)', '2n')).toBe(
      'expect(f(1n)).toBe(2n);',
    );
  });

  it('refuses test file filters that read as options or leave the directory', async () => {
    for (const file of ['--config=evil.js', '../x.test.ts', '/abs/x.test.ts', '']) {
      const run = await vitestTestRunner.execution.run(process.cwd(), {
        timeoutMs: 1000,
        label: 't',
        files: [file],
      });

      expect(run).toEqual({ status: 'error', detail: `invalid test file: ${JSON.stringify(file)}` });
    }
  });
});
