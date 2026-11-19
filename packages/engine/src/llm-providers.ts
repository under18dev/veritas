import { llmAvailability, type VeritasConfig } from '@under18dev/veritas-core';
import type { LlmProvider } from '@under18dev/veritas-llm';
import { ClaudeProvider } from '@under18dev/veritas-llm-claude';
import { ClaudeCodeProvider } from '@under18dev/veritas-llm-claude-code';
import { CodexProvider } from '@under18dev/veritas-llm-codex';
import { OpenAiProvider } from '@under18dev/veritas-llm-openai';

/**
 * Build the configured provider when it can be used, or explain why not. Nothing is fabricated without one:
 * the run falls back to rule-based results.
 */
export async function createLlmProvider(
  config: VeritasConfig,
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ provider: LlmProvider | null; message: string | null }> {
  const name = config.llm.provider;
  if (name === 'none') return { provider: null, message: null };
  const availability = await llmAvailability(name, env, root);
  if (availability.state !== 'available')
    return { provider: null, message: `llm: ${availability.detail}; rule-based results only` };
  const model = config.llm.model ? { model: config.llm.model } : {};
  switch (name) {
    case 'claude':
      return { provider: new ClaudeProvider(model), message: null };
    case 'openai':
      return { provider: new OpenAiProvider(model), message: null };
    case 'claude-code':
      return { provider: new ClaudeCodeProvider(model), message: null };
    case 'codex':
      return { provider: new CodexProvider(model), message: null };
  }
}
