import {
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
  renderDocuments,
  SYSTEM_PREAMBLE,
} from '@under18dev/veritas-llm';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { z } from 'zod';

export const DEFAULT_MODEL = 'gpt-5.5';

/** The part of the OpenAI client this adapter uses; injectable for tests. */
export interface ResponsesParser {
  responses: { parse: OpenAI['responses']['parse'] };
}

export interface OpenAiOptions {
  model?: string;
  apiKey?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  client?: ResponsesParser;
}

/** OpenAI adapter (Responses API): strict structured output validated against the request schema. */
export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';
  readonly model: string;
  private readonly client: ResponsesParser;

  constructor(options: OpenAiOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.client =
      options.client ??
      new OpenAI({
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
      const response = await this.client.responses.parse(
        {
          model: this.model,
          instructions: SYSTEM_PREAMBLE,
          input: `${request.instructions}\n\n${renderDocuments(request.documents)}`,
          max_output_tokens: request.maxOutputTokens,
          store: false,
          text: { format: zodTextFormat(request.schema as never, 'veritas_result') },
        },
        request.signal ? { signal: request.signal } : undefined,
      );
      const usage = {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      };
      const refusal = response.output
        .flatMap((item) => (item.type === 'message' ? item.content : []))
        .find((part) => part.type === 'refusal');
      if (refusal) return { ...base, status: 'refused', data: null, usage, error: refusal.refusal };
      if (response.incomplete_details?.reason === 'max_output_tokens')
        return { ...base, status: 'truncated', data: null, usage, error: 'output reached max_output_tokens' };
      const parsed = request.schema.safeParse(response.output_parsed);
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
      if (error instanceof OpenAI.AuthenticationError)
        return { ...base, status: 'unavailable', data: null, usage, error: 'invalid API key' };
      if (error instanceof OpenAI.RateLimitError)
        return { ...base, status: 'error', data: null, usage, error: 'rate limited' };
      if (error instanceof OpenAI.APIError)
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
