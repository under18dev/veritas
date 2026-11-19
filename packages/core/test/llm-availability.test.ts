import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { LLM_CLI_ENV_ALLOWLIST, llmAvailability } from '../src/index.js';

describe('llmAvailability', () => {
  it('is disabled without a provider and needs the matching key for API providers', async () => {
    expect((await llmAvailability('none', {}, tmpdir())).state).toBe('disabled');
    expect(await llmAvailability('claude', {}, tmpdir())).toMatchObject({
      state: 'unavailable',
      detail: expect.stringMatching(/ANTHROPIC_API_KEY is not set/),
    });
    expect((await llmAvailability('claude', { ANTHROPIC_API_KEY: 'x' }, tmpdir())).state).toBe('available');
    expect(await llmAvailability('openai', { ANTHROPIC_API_KEY: 'x' }, tmpdir())).toMatchObject({
      state: 'unavailable',
      detail: expect.stringMatching(/OPENAI_API_KEY is not set/),
    });
    expect((await llmAvailability('openai', { OPENAI_API_KEY: 'x' }, tmpdir())).state).toBe('available');
  });

  it('never passes API keys to provider CLIs', () => {
    expect(LLM_CLI_ENV_ALLOWLIST).toContain('USER');
    expect(LLM_CLI_ENV_ALLOWLIST.some((name) => /KEY|TOKEN|SECRET/.test(name))).toBe(false);
  });

  it('does not use codex unless reading local files is explicitly allowed', async () => {
    expect(await llmAvailability('codex', {}, tmpdir())).toMatchObject({
      state: 'unavailable',
      detail: expect.stringMatching(/llm.allowCodexFileReads/),
    });
  });
});
