import type { Run } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import { recordedRunOptions } from '../src/index.js';

const run = (overrides: Partial<Run>): Run =>
  ({
    runId: 'run-1',
    command: 'run',
    args: ['run', '--profile', 'deep'],
    profile: 'deep',
    status: 'succeeded',
    scope: { root: '/p', paths: [] },
    stages: [],
    ...overrides,
  }) as unknown as Run;

describe('recordedRunOptions', () => {
  it('gives back every option the run recorded', () => {
    const options = recordedRunOptions(
      run({
        scope: { root: '/p', since: 'main', paths: ['src/a.ts'] },
        options: {
          includeProposed: true,
          offline: false,
          propertyIds: ['P-1'],
          formalEngine: 'lean',
          sources: ['local', 'web'],
          web: { allowDomains: ['example.com'], maxPages: 3 },
          mutationReport: 'reports/mutation.json',
          killMatrix: true,
        },
      }),
    );
    expect(options).toEqual({
      args: ['run', '--profile', 'deep'],
      profile: 'deep',
      includeProposed: true,
      propertyIds: ['P-1'],
      formalEngine: 'lean',
      sources: ['local', 'web'],
      web: { allowDomains: ['example.com'], maxPages: 3 },
      mutationReport: 'reports/mutation.json',
      killMatrix: true,
      scope: ['src/a.ts'],
      since: 'main',
    });
  });

  it('falls back to the arguments for runs recorded without options', () => {
    expect(recordedRunOptions(run({ args: ['prove', '--include-proposed'] })).includeProposed).toBe(true);
    expect(recordedRunOptions(run({})).scope).toBeUndefined();
  });
});
