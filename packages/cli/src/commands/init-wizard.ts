import type { LlmAvailability, LlmProviderName, ProjectInfo, VeritasConfig } from '@under18dev/veritas-core';

/** How the wizard talks to the user. */
export interface Prompter {
  ask(question: string): Promise<string>;
  say(line: string): void;
}

/** What the wizard reads from the machine and the project. Injected so it can be tested. */
export interface WizardEnvironment {
  project: ProjectInfo;
  /** Whether a provider can be used; codex is only probed once the user allowed its file reads. */
  llm(provider: LlmProviderName, allowCodexFileReads?: boolean): Promise<LlmAvailability>;
  /** Whether `lean` (and Lake) can be found, as `veritas doctor` looks for them. */
  leanAvailable(): Promise<boolean>;
  /** `owner/name` of the git remote `origin` on GitHub, if any. */
  githubRepo(): string | null;
  /** Whether the project itself has @mizchi/mutator (the bundled copy loads some of its files from outside the project). */
  projectHasMutator: boolean;
  /** The mutator version Veritas runs, to add the same one to the project. */
  mutatorVersion: string | null;
}

/** Work the user agreed to, done only after they confirm writing the configuration. */
export type WizardAction = { kind: 'install-lean' } | { kind: 'add-mutator'; command: string[] };

export interface WizardResult {
  config: VeritasConfig;
  actions: WizardAction[];
}

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
// The same rule as `sources.web.allowDomains` in the configuration schema.
const DOMAIN = /^[a-z0-9.-]+$/i;

const yes = (answer: string) => /^y(es)?$/i.test(answer.trim());

/** The command that adds a dev dependency with the project's package manager. */
export function addDevDependency(manager: ProjectInfo['packageManager'], spec: string): string[] {
  switch (manager) {
    case 'pnpm':
      return ['pnpm', 'add', '-D', spec];
    case 'yarn':
      return ['yarn', 'add', '-D', spec];
    case 'bun':
      return ['bun', 'add', '-d', spec];
    default:
      return ['npm', 'install', '-D', spec];
  }
}

const PROVIDERS: { name: LlmProviderName; label: string }[] = [
  { name: 'none', label: 'none: rule-based analysis only' },
  { name: 'claude', label: 'claude: Anthropic API (ANTHROPIC_API_KEY)' },
  { name: 'claude-code', label: 'claude-code: your logged-in `claude` CLI' },
  { name: 'codex', label: 'codex: your logged-in `codex` CLI' },
  { name: 'openai', label: 'openai: OpenAI API (OPENAI_API_KEY)' },
];

/**
 * Ask about the settings `veritas init` cannot detect: an LLM provider, GitHub and web sources, Lean and the
 * project's own mutator. Every question defaults to leaving things as they are; nothing is installed here.
 */
export async function runInitWizard(
  proposed: VeritasConfig,
  env: WizardEnvironment,
  prompter: Prompter,
): Promise<WizardResult> {
  const config = structuredClone(proposed);
  const actions: WizardAction[] = [];

  // LLM provider.
  prompter.say('LLM provider (reads documentation that rules cannot; its proposals still need your review):');

  for (const [index, provider] of PROVIDERS.entries()) {
    // codex is not run before the user allows its read-only shell to read local files.
    const state =
      provider.name === 'none'
        ? ''
        : provider.name === 'codex'
          ? ' [asks for permission first]'
          : ` [${(await env.llm(provider.name)).state === 'available' ? 'available' : 'not set up'}]`;
    prompter.say(`  ${index + 1}) ${provider.label}${state}`);
  }
  const choice = Number.parseInt((await prompter.ask('Choose 1-5 [1]: ')).trim() || '1', 10);
  const provider = PROVIDERS[choice - 1]?.name ?? 'none';

  if (provider === 'codex') {
    // The codex CLI keeps a read-only shell, so it is only used when the user allows it to read local files.
    if (yes(await prompter.ask("codex's read-only shell can read files on this machine. Allow it? [y/N] "))) {
      config.llm.provider = 'codex';
      config.llm.allowCodexFileReads = true;
    } else prompter.say('  codex not enabled; keeping rule-based analysis');
  } else config.llm.provider = provider;

  if (config.llm.provider !== 'none') {
    const availability = await env.llm(config.llm.provider, config.llm.allowCodexFileReads);

    if (availability.state !== 'available') prompter.say(`  note: ${availability.detail}`);
  }

  // GitHub issues and pull requests.
  if (yes(await prompter.ask('Read GitHub issues and pull requests as specification evidence? [y/N] '))) {
    const detected = env.githubRepo();

    for (;;) {
      const answer = (
        await prompter.ask(`  Repository (owner/name)${detected ? ` [${detected}]` : ''}: `)
      ).trim();
      const repo = answer || detected;

      if (!repo) {
        prompter.say('  no repository given; GitHub stays off');
        break;
      }

      if (REPO.test(repo)) {
        config.sources.github = { enabled: true, repo };
        prompter.say(
          '  GitHub is read only in runs without --offline; set GITHUB_TOKEN to avoid rate limits',
        );
        break;
      }
      prompter.say('  expected owner/name');
    }
  }

  // Web pages.
  if (yes(await prompter.ask('Read web pages as specification evidence? [y/N] '))) {
    for (;;) {
      const answer = await prompter.ask('  Allowed domains, comma-separated (empty to skip): ');
      const domains = answer
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean);

      if (domains.length === 0) {
        prompter.say('  no domain given; web stays off');
        break;
      }
      const invalid = domains.filter((d) => !DOMAIN.test(d));

      if (invalid.length === 0) {
        config.sources.web = { ...config.sources.web, enabled: true, allowDomains: domains };
        prompter.say('  web pages are fetched only in runs without --offline, and only from these domains');
        break;
      }
      prompter.say(`  not a domain: ${invalid.join(', ')}`);
    }
  }

  // Lean 4.
  let lean = await env.leanAvailable();

  if (
    !lean &&
    yes(
      await prompter.ask(
        'Lean 4 is not installed. Install it with elan (downloads the official installer from GitHub)? [y/N] ',
      ),
    )
  ) {
    actions.push({ kind: 'install-lean' });
    lean = true;
  }

  if (
    lean &&
    yes(
      await prompter.ask(
        'Use Lean instead of Z3 for proofs in `veritas run`? Lean covers integers and booleans only; Z3 also covers records and arrays. [y/N] ',
      ),
    )
  )
    config.formal.backend = 'lean';

  // The project's own mutator.
  if (!env.projectHasMutator && env.mutatorVersion) {
    const command = addDevDependency(env.project.packageManager, `@mizchi/mutator@${env.mutatorVersion}`);

    if (
      yes(
        await prompter.ask(
          `Add @mizchi/mutator to the project (\`${command.join(' ')}\`)? Mutation testing then uses the project's Vitest, test environments and plugins. [y/N] `,
        ),
      )
    )
      actions.push({ kind: 'add-mutator', command });
  }

  return { config, actions };
}
