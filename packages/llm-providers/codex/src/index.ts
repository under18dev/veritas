import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

export interface CodexOptions {
  /** Model passed to `codex exec --model`; the CLI's default when omitted. */
  model?: string;
  /** Executable to run; `codex` on PATH by default. */
  command?: string;
  /** Arguments placed before the CLI arguments, e.g. a script path when `command` is `node`. */
  commandArgs?: string[];
  timeoutMs?: number;
}

/**
 * Runs the locally installed Codex CLI (`codex exec`), so requests use the user's own `codex login`
 * (for example a ChatGPT plan). Veritas never reads or stores those credentials.
 *
 * The CLI runs in an empty temporary directory with the read-only sandbox, ephemeral sessions and no git
 * repository: it only sees the prompt, and documents in the prompt are quoted untrusted data.
 */
export class CodexProvider implements LlmProvider {
  readonly name = 'codex';
  readonly model: string;
  private readonly command: string;
  private readonly commandArgs: string[];
  private readonly timeoutMs: number;
  private readonly explicitModel: string | undefined;

  constructor(options: CodexOptions = {}) {
    this.explicitModel = options.model;
    this.model = options.model ?? 'codex-default';
    this.command = options.command ?? 'codex';
    this.commandArgs = options.commandArgs ?? [];
    this.timeoutMs = options.timeoutMs ?? 300_000;
  }

  async complete<S extends z.ZodType>(
    request: LlmRequest<S>,
  ): Promise<Omit<LlmResult<z.output<S>>, 'inputHash'>> {
    const base = { provider: this.name, model: this.model };
    const empty = { inputTokens: 0, outputTokens: 0 };
    const dir = mkdtempSync(path.join(tmpdir(), 'veritas-codex-'));
    const work = path.join(dir, 'work');
    const schemaFile = path.join(dir, 'schema.json');
    const outFile = path.join(dir, 'out.json');
    try {
      writeFileSync(schemaFile, JSON.stringify(jsonSchemaOf(request.schema)));
      mkdirSync(work);
      const args = [
        'exec',
        '--skip-git-repo-check',
        '--ephemeral',
        '--sandbox',
        'read-only',
        '--cd',
        work,
        '--output-schema',
        schemaFile,
        '--output-last-message',
        outFile,
        '--json',
        ...(this.explicitModel ? ['--model', this.explicitModel] : []),
        '-',
      ];
      const run = await runCommand(this.command, [...this.commandArgs, ...args], {
        cwd: work,
        timeoutMs: this.timeoutMs,
        envAllowlist: LLM_CLI_ENV_ALLOWLIST,
        input: `${SYSTEM_PREAMBLE}\n\n${renderPrompt(request)}`,
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
      const usage = usageFrom(run.stdout);
      if (run.exitCode !== 0) {
        const detail = (run.stderr || run.stdout).trim().split('\n').slice(-3).join(' ');
        const loggedOut = /log ?in|auth|credential|unauthori[sz]ed/i.test(detail);
        return {
          ...base,
          status: loggedOut ? 'unavailable' : 'error',
          data: null,
          usage,
          error: `${this.command} exited ${run.exitCode}: ${detail}`,
        };
      }
      let output: unknown;
      try {
        output = JSON.parse(readFileSync(outFile, 'utf8'));
      } catch {
        return { ...base, status: 'invalid_output', data: null, usage, error: 'no JSON final message' };
      }
      const result = request.schema.safeParse(output);
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
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Sum the token usage of every `turn.completed` event in `codex exec --json` output. */
function usageFrom(stdout: string): { inputTokens: number; outputTokens: number } {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (event.type === 'turn.completed') {
        inputTokens += event.usage?.input_tokens ?? 0;
        outputTokens += event.usage?.output_tokens ?? 0;
      }
    } catch {
      // not an event line
    }
  }
  return { inputTokens, outputTokens };
}
