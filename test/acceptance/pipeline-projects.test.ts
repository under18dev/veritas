import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { json, runCli } from './helpers.js';
import { type RunJson, readRunArtifact, setup } from './pipeline-shared.js';

function write(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), content);
  }
}

describe('discount-boundary end to end: Vitest projects', () => {
  it('runs the selected tests in the matching project only, with a config file glob and an extglob include', () => {
    const dir = setup('discount-boundary');
    write(dir, {
      // Laid out like Hono's: runtime tests in projects of their own, and the unit tests matched by an extglob.
      'vitest.config.mjs': `export default {
        test: {
          projects: [
            './runtime-tests/*/vitest.config.mjs',
            { test: { name: 'unit', include: ['test/**/(*.)+(spec|test).+(ts|js)'] } },
          ],
        },
      };`,
      'runtime-tests/edge/vitest.config.mjs': "export default { test: { name: 'edge' } };",
      'runtime-tests/edge/index.test.ts': [
        "import { it } from 'vitest';",
        "import { discountAmount } from '../../src/pricing.js';",
        "it('needs a runtime that is not there', () => { discountAmount(1); throw new Error('runtime test ran'); });",
        '',
      ].join('\n'),
    });
    // The runtime tests are not among the tests Veritas analyses, as in a project that runs them elsewhere.
    const configPath = path.join(dir, '.veritas/config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { analysis: { testInclude: string[] } };
    config.analysis.testInclude = ['test/**/*.test.ts'];
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const run = json<RunJson>(runCli(['run', '--profile', 'standard', '--json'], dir));
    const mutate = run.stages.find((s) => s.stage === 'mutate');
    expect(mutate?.status, mutate?.messages.join('\n')).toBe('succeeded');
    const mutation = readRunArtifact<{ counts: Record<string, number> }>(dir, run.runId, 'mutation.json');
    expect(mutation.counts.killed).toBeGreaterThan(0);
  });
});
