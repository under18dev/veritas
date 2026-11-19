import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LLM_CLI_ENV_ALLOWLIST, runCommand } from '@under18dev/veritas-core';
import {
  jsonSchemaOf,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
  renderPrompt,
  SYSTEM_PREAMBLE,
} from '@under18dev/veritas-llm';
import type { z } from 'zod';

export interface ClaudeCodeOptions {
  /** Model alias or name passed to `claude --model`; the CLI's default when omitted. */
  model?: string;
  /** Executable to run; `claude` on PATH by default. */
  command?: string;
  /** Arguments placed before the CLI arguments, e.g. a script path when `command` is `node`. */
  commandArgs?: string[];
  timeoutMs?: number;
}

/** The fields of `claude -p --output-format json` this adapter reads. */
interface ClaudeCodeResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/**
 * Runs the locally installed Claude Code CLI in print mode, so requests use the user's own `claude` login
 * (for example a Pro or Max subscription). Veritas never reads or stores those credentials.
 *
 * The CLI runs with every tool disabled, no MCP servers, no settings or session files, and an empty temporary
 * working directory: it only sees the prompt, and documents in the prompt are quoted untrusted data.
 */
export class ClaudeCodeProvider implements LlmProvider {
  readonly name = 'claude-code';
  readonly model: string;
  private readonly command: string;
  private readonly commandArgs: string[];
  private readonly timeoutMs: number;
  private readonly explicitModel: string | undefined;

  constructor(options: ClaudeCodeOptions = {}) {
    this.explicitModel = options.model;
    this.model = options.model ?? 'claude-code-default';
    this.command = options.command ?? 'claude';
    this.commandArgs = options.commandArgs ?? [];
    this.timeoutMs = options.timeoutMs ?? 300_000;
  }

  async complete<S extends z.ZodType>(
    request: LlmRequest<S>,
  ): Promise<Omit<LlmResult<z.output<S>>, 'inputHash'>> {
    const base = { provider: this.name, model: this.model };
    const empty = { inputTokens: 0, outputTokens: 0 };
    const cwd = mkdtempSync(path.join(tmpdir(), 'veritas-claude-code-'));
    try {
      const args = [
        '-p',
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(jsonSchemaOf(request.schema)),
        '--system-prompt',
        SYSTEM_PREAMBLE,
        '--tools',
        '',
        '--strict-mcp-config',
        '--setting-sources',
        '',
        '--no-session-persistence',
        ...(this.explicitModel ? ['--model', this.explicitModel] : []),
      ];
      const run = await runCommand(this.command, [...this.commandArgs, ...args], {
        cwd,
        timeoutMs: this.timeoutMs,
        envAllowlist: LLM_CLI_ENV_ALLOWLIST,
        input: renderPrompt(request),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      if (run.spawnError)
        return {
          ...base,
          status: 'unavailable',
          data: null,
          usage: empty,
          error: `cannot run ${this.command}: ${run.spawnError}`,
        };
      if (run.timedOut)
        return { ...base, status: 'error', data: null, usage: empty, error: `${this.command} timed out` };
      let parsed: ClaudeCodeResult;
      try {
        parsed = JSON.parse(run.stdout) as ClaudeCodeResult;
      } catch {
        const detail = (run.stderr || run.stdout).trim().split('\n').slice(-3).join(' ');
        return {
          ...base,
          status: run.exitCode === 0 ? 'invalid_output' : 'error',
          data: null,
          usage: empty,
          error: `${this.command} exited ${run.exitCode}: ${detail || 'no JSON result'}`,
        };
      }
      const u = parsed.usage ?? {};
      const usage = {
        inputTokens:
          (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        outputTokens: u.output_tokens ?? 0,
      };
      if (parsed.is_error || parsed.subtype !== 'success') {
        const message = parsed.result ?? parsed.subtype ?? 'error';
        const loggedOut = /log ?in|auth|credential/i.test(message);
        return { ...base, status: loggedOut ? 'unavailable' : 'error', data: null, usage, error: message };
      }
      if (parsed.stop_reason === 'refusal')
        return { ...base, status: 'refused', data: null, usage, error: 'refused' };
      if (parsed.stop_reason === 'max_tokens')
        return { ...base, status: 'truncated', data: null, usage, error: 'output reached max_tokens' };
      const result = request.schema.safeParse(parsed.structured_output);
      if (!result.success)
        return {
          ...base,
          status: 'invalid_output',
          data: null,
          usage,
          error: 'output did not match the schema',
        };
      return { ...base, status: 'ok', data: result.data as z.output<S>, usage, error: null };
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
}
