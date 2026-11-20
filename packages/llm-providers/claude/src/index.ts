import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
  renderDocuments,
  SYSTEM_PREAMBLE,
} from '@under18dev/veritas-llm';
import type { z } from 'zod';

export const DEFAULT_MODEL = 'claude-opus-5-5';

/** The part of the Anthropic client this adapter uses; injectable for tests. */
export interface MessagesParser {
  messages: { parse: Anthropic['messages']['parse'] };
}

export interface ClaudeOptions {
  model?: string;
  apiKey?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  client?: MessagesParser;
}

/** Claude adapter: structured JSON output validated against the request schema. */
export class ClaudeProvider implements LlmProvider {
  readonly name = 'claude';
  readonly model: string;
  private readonly client: MessagesParser;

  constructor(options: ClaudeOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.client =
      options.client ??
      new Anthropic({
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        timeout: options.timeoutMs ?? 120_000,
        maxRetries: 2,
      });
  }

  async complete<S extends z.ZodType>(
    request: LlmRequest<S>,
  ): Promise<Omit<LlmResult<z.output<S>>, 'inputHash'>> {
    const base = { provider: this.name, model: this.model };

    try {
      const response = await this.client.messages.parse(
        {
          model: this.model,
          max_tokens: request.maxOutputTokens,
          system: SYSTEM_PREAMBLE,
          output_config: { effort: 'low', format: zodOutputFormat(request.schema as never) },
          messages: [
            { role: 'user', content: `${request.instructions}\n\n${renderDocuments(request.documents)}` },
          ],
        },
        request.signal ? { signal: request.signal } : undefined,
      );
      const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };

      if (response.stop_reason === 'refusal') {
        return {
          ...base,
          status: 'refused',
          data: null,
          usage,
          error: response.stop_details?.explanation ?? 'refused',
        };
      }

      if (response.stop_reason === 'max_tokens') {
        return { ...base, status: 'truncated', data: null, usage, error: 'output reached max_tokens' };
      }
      const parsed = request.schema.safeParse(response.parsed_output);

      if (!parsed.success)
        return {
          ...base,
          status: 'invalid_output',
          data: null,
          usage,
          error: 'output did not match the schema',
        };

      return { ...base, status: 'ok', data: parsed.data as z.output<S>, usage, error: null };
    } catch (error) {
      const usage = { inputTokens: 0, outputTokens: 0 };

      if (error instanceof Anthropic.AuthenticationError)
        return { ...base, status: 'unavailable', data: null, usage, error: 'invalid API key' };

      if (error instanceof Anthropic.RateLimitError)
        return { ...base, status: 'error', data: null, usage, error: 'rate limited' };

      if (error instanceof Anthropic.APIError)
        return { ...base, status: 'error', data: null, usage, error: `API error ${error.status}` };

      return {
        ...base,
        status: 'error',
        data: null,
        usage,
        error: (error as Error).message ?? String(error),
      };
    }
  }
}
