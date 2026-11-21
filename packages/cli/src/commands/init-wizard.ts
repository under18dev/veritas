import type {
  LlmAvailability,
  LlmProviderName,
  ProjectInfo,
  TestFramework,
  VeritasConfig,
} from '@under18dev/veritas-core';

/** How the wizard talks to the user. */
export interface Prompter {
  /** Free text, such as a repository name. */
  ask(question: string): Promise<string>;
  say(line: string): void;
  /** One of `choices`, as its index; `initial` is the default. */
  select(question: string, choices: string[], initial?: number): Promise<number>;
  /** A yes/no question; `initial` is the default. */
  confirm(question: string, initial?: boolean): Promise<boolean>;
}

/** Choices and yes/no questions answered by typing, for when the terminal cannot take arrow keys. */
export function withTypedChoices<T extends Pick<Prompter, 'ask' | 'say'>>(base: T): T & Prompter {
  return {
    ...base,
    async select(question, choices, initial = 0) {
      base.say(question);

      for (const [index, choice] of choices.entries()) base.say(`  ${index + 1}) ${choice}`);
      const answer = (await base.ask(`Choose 1-${choices.length} [${initial + 1}]: `)).trim();
      const index = answer ? Number.parseInt(answer, 10) - 1 : initial;

      return index >= 0 && index < choices.length ? index : initial;
    },
    async confirm(question, initial = false) {
      const answer = (await base.ask(`${question} ${initial ? '[Y/n]' : '[y/N]'} `)).trim();

      return answer ? /^y(es)?$/i.test(answer) : initial;
    },
  };
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
  /**
   * Test runners detection found when it could not tell which one the project uses (more than one, and the test
   * script runs neither or both); the wizard then asks. Absent or empty when detection decided.
   */
  ambiguousTestRunners?: { name: TestFramework; label: string }[];
  /**
   * The test globs detection proposes for a runner (`__tests__/` files count only when they use it), so a runner
   * picked here gets its own instead of those proposed for the default.
   */
  testGlobsFor?(framework: TestFramework): string[];
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

  // Test runner, only when detection could not decide; the default is the runner it chose.
  const runners = env.ambiguousTestRunners ?? [];

  if (runners.length > 1) {
    const initial = Math.max(
      0,
      runners.findIndex((runner) => runner.name === config.analysis.testFramework),
    );
    const picked = await prompter.select(
      'More than one test runner was found. Which one runs the tests of this project?',
      runners.map((runner) => runner.label),
      initial,
    );
    const chosen = runners[picked]?.name ?? config.analysis.testFramework;

    if (chosen !== config.analysis.testFramework && env.testGlobsFor)
      config.analysis.testInclude = env.testGlobsFor(chosen);
    config.analysis.testFramework = chosen;
  }

  // LLM provider.
  const labels: string[] = [];

  for (const provider of PROVIDERS) {
    // codex is not run before the user allows its read-only shell to read local files.
    const state =
      provider.name === 'none'
        ? ''
        : provider.name === 'codex'
          ? ' [asks for permission first]'
          : ` [${(await env.llm(provider.name)).state === 'available' ? 'available' : 'not set up'}]`;
    labels.push(`${provider.label}${state}`);
  }
  const choice = await prompter.select(
    'LLM provider (reads documentation that rules cannot; its proposals still need your review):',
    labels,
  );
  const provider = PROVIDERS[choice]?.name ?? 'none';

  if (provider === 'codex') {
    // The codex CLI keeps a read-only shell, so it is only used when the user allows it to read local files.
    if (await prompter.confirm("codex's read-only shell can read files on this machine. Allow it?")) {
      config.llm.provider = 'codex';
      config.llm.allowCodexFileReads = true;
    } else prompter.say('  codex not enabled; keeping rule-based analysis');
  } else config.llm.provider = provider;

  if (config.llm.provider !== 'none') {
    const availability = await env.llm(config.llm.provider, config.llm.allowCodexFileReads);

    if (availability.state !== 'available') prompter.say(`  note: ${availability.detail}`);
  }

  // GitHub issues and pull requests.
  if (await prompter.confirm('Read GitHub issues and pull requests as specification evidence?')) {
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
  if (await prompter.confirm('Read web pages as specification evidence?')) {
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
    (await prompter.confirm(
      'Lean 4 is not installed. Install it with elan (downloads the official installer from GitHub)?',
    ))
  ) {
    actions.push({ kind: 'install-lean' });
    lean = true;
  }

  if (
    lean &&
    (await prompter.confirm(
      'Also prove properties with Lean? Z3 keeps checking the implementation; Lean adds kernel-checked proofs for properties over integers and booleans.',
      true,
    ))
  )
    config.formal.backend = 'both';

  // The project's own mutator.
  if (!env.projectHasMutator && env.mutatorVersion) {
    const command = addDevDependency(env.project.packageManager, `@mizchi/mutator@${env.mutatorVersion}`);

    if (
      await prompter.confirm(
        `Add @mizchi/mutator to the project (\`${command.join(' ')}\`)? Mutation testing then loads all of mutator's files from the project instead of from where Veritas is installed.`,
      )
    )
      actions.push({ kind: 'add-mutator', command });
  }

  return { config, actions };
}
