import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { discoverEvidence } from '../src/index.js';
import { config, fixture } from './helpers.js';

describe('untrusted statement safety', () => {
  it('never executes instruction-like content, changes config, writes files, or makes network calls', async () => {
    const root = fixture('security');
    const before = readdirSync(root).sort();
    let calls = 0;
    const result = await discoverEvidence({
      root,
      config: config({ web: { enabled: true, allowDomains: ['attacker.invalid'] } }),
      fetch: async () => {
        calls++;
        return new Response('');
      },
      offline: true,
    });
    expect(result.statements.some((statement) => statement.flags.includes('instruction_like'))).toBe(true);
    expect(result.networkRequests).toBe(0);
    expect(calls).toBe(0);
    expect(readdirSync(root).sort()).toEqual(before);
    expect(result.skipped).not.toContainEqual(
      expect.objectContaining({ reason: expect.stringContaining('config') }),
    );
  });
});
