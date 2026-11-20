import type { VeritasConfig } from '../config/schema.js';
import { DEFAULT_ENV_ALLOWLIST, resolveCommand, runCommand } from '../process.js';

export type LlmProviderName = VeritasConfig['llm']['provider'];

/**
 * Environment for provider CLIs (`claude`, `codex`): what they need to find the user's own login and
 * configuration (the macOS keychain needs USER). API keys are never passed, so the CLI uses its login.
 */
export const LLM_CLI_ENV_ALLOWLIST = [
  ...DEFAULT_ENV_ALLOWLIST,
  'USER',
  'LOGNAME',
  'USERNAME',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
];

export interface LlmAvailability {
  state: 'disabled' | 'available' | 'unavailable';
  detail: string;
}

/**
 * Whether the configured LLM provider can be used, without sending a request.
 * API providers need their key in the environment; CLI providers need the CLI installed and logged in.
 * Only the login state is read from the CLI; account details are not recorded.
 */
export async function llmAvailability(
  provider: LlmProviderName,
  env: NodeJS.ProcessEnv,
  cwd: string,
  options: { allowCodexFileReads?: boolean } = {},
): Promise<LlmAvailability> {
  switch (provider) {
    case 'none':
      return { state: 'disabled', detail: 'no LLM provider configured; rule-based analysis only' };
    case 'claude':
      return env.ANTHROPIC_API_KEY
        ? { state: 'available', detail: 'claude configured, ANTHROPIC_API_KEY present' }
        : { state: 'unavailable', detail: 'claude configured but ANTHROPIC_API_KEY is not set' };
    case 'openai':
      return env.OPENAI_API_KEY
        ? { state: 'available', detail: 'openai configured, OPENAI_API_KEY present' }
        : { state: 'unavailable', detail: 'openai configured but OPENAI_API_KEY is not set' };
    case 'claude-code': {
      const run = await runCli('claude', ['auth', 'status'], cwd);

      if (!run)
        return { state: 'unavailable', detail: 'claude-code configured but `claude` is not installed' };
      let loggedIn = false;
      let method = 'unknown';

      try {
        const status = JSON.parse(run.stdout) as { loggedIn?: boolean; authMethod?: string };
        loggedIn = status.loggedIn === true;
        method = status.authMethod ?? method;
      } catch {
        loggedIn = false;
      }

      return loggedIn
        ? { state: 'available', detail: `claude-code configured, \`claude\` is logged in (${method})` }
        : {
            state: 'unavailable',
            detail: 'claude-code configured but `claude` is not logged in (run `claude auth login`)',
          };
    }
    case 'codex': {
      if (!options.allowCodexFileReads)
        return {
          state: 'unavailable',
          detail:
            'codex configured but not enabled: its read-only shell can read local files, so set llm.allowCodexFileReads to use it',
        };
      const run = await runCli('codex', ['login', 'status'], cwd);

      if (!run) return { state: 'unavailable', detail: 'codex configured but `codex` is not installed' };
      const text = `${run.stdout}\n${run.stderr}`;

      return run.exitCode === 0 && /logged in/i.test(text) && !/not logged in/i.test(text)
        ? { state: 'available', detail: 'codex configured, `codex` is logged in' }
        : {
            state: 'unavailable',
            detail: 'codex configured but `codex` is not logged in (run `codex login`)',
          };
    }
  }
}

/** Run a provider CLI status command; `null` when the CLI is not installed or cannot be started without a shell. */
async function runCli(name: string, args: string[], cwd: string) {
  const resolved = resolveCommand(name);

  if (!resolved) return null;
  const run = await runCommand(resolved.command, [...resolved.prefix, ...args], {
    cwd,
    timeoutMs: 30_000,
    envAllowlist: LLM_CLI_ENV_ALLOWLIST,
  });

  return run.spawnError ? null : run;
}
