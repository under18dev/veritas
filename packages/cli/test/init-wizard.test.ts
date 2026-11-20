import { type ProjectInfo, VeritasConfig } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import { asksQuestions, githubRepoFromRemote, installerCommand, perform } from '../src/commands/init.js';
import {
  addDevDependency,
  type Prompter,
  runInitWizard,
  type WizardEnvironment,
} from '../src/commands/init-wizard.js';

const proposed = VeritasConfig.parse({});

function scripted(answers: string[]): Prompter & { questions: string[]; lines: string[] } {
  const queue = [...answers];
  const questions: string[] = [];
  const lines: string[] = [];

  return {
    questions,
    lines,
    ask: async (question) => {
      questions.push(question);

      return queue.shift() ?? '';
    },
    say: (line) => lines.push(line),
  };
}

function environment(overrides: Partial<WizardEnvironment> = {}): WizardEnvironment {
  return {
    project: { packageManager: 'pnpm' } as ProjectInfo,
    llm: async (provider) =>
      provider === 'claude-code'
        ? { state: 'available', detail: 'logged in' }
        : { state: 'unavailable', detail: `${provider} is not set up` },
    leanAvailable: async () => false,
    githubRepo: () => 'acme/shop',
    projectHasMutator: false,
    mutatorVersion: '0.4.5',
    ...overrides,
  };
}

describe('init wizard', () => {
  it('changes nothing and installs nothing when every answer is the default', async () => {
    const result = await runInitWizard(proposed, environment(), scripted([]));
    expect(result.config).toEqual(proposed);
    expect(result.actions).toEqual([]);
  });

  it('applies the answers and defers installs until the configuration is confirmed', async () => {
    const prompter = scripted([
      '3', // claude-code
      'y', // GitHub
      '', // keep the detected repository
      'y', // web
      'docs.example.com, bad domain!', // rejected
      'docs.example.com, api.example.com',
      'y', // install Lean
      'y', // use Lean
      'y', // add mutator
    ]);
    const result = await runInitWizard(proposed, environment(), prompter);
    expect(result.config.llm.provider).toBe('claude-code');
    expect(result.config.sources.github).toEqual({ enabled: true, repo: 'acme/shop' });
    expect(result.config.sources.web).toMatchObject({
      enabled: true,
      allowDomains: ['docs.example.com', 'api.example.com'],
    });
    expect(result.config.formal.backend).toBe('lean');
    expect(result.actions).toEqual([
      { kind: 'install-lean' },
      { kind: 'add-mutator', command: ['pnpm', 'add', '-D', '@mizchi/mutator@0.4.5'] },
    ]);
    expect(prompter.lines).toContain('  not a domain: bad domain!');
    expect(prompter.lines.some((l) => l.includes('claude-code') && l.includes('[available]'))).toBe(true);
    // The result is a valid configuration.
    expect(VeritasConfig.parse(result.config)).toEqual(result.config);
  });

  it('does not run codex to check it before the user allows its file reads', async () => {
    const probed: [string, boolean | undefined][] = [];
    const env = environment({
      llm: async (provider, allow) => {
        probed.push([provider, allow]);

        return { state: 'unavailable', detail: 'x' };
      },
    });
    await runInitWizard(proposed, env, scripted(['1']));
    expect(probed.some(([p]) => p === 'codex')).toBe(false);
    probed.length = 0;
    await runInitWizard(proposed, env, scripted(['4', 'y']));
    expect(probed.filter(([p]) => p === 'codex')).toEqual([['codex', true]]);
  });

  it('enables codex only when the user allows its file reads', async () => {
    const declined = await runInitWizard(proposed, environment(), scripted(['4', 'n']));
    expect(declined.config.llm).toMatchObject({ provider: 'none', allowCodexFileReads: false });
    const allowed = await runInitWizard(proposed, environment(), scripted(['4', 'y']));
    expect(allowed.config.llm).toMatchObject({ provider: 'codex', allowCodexFileReads: true });
  });

  it('asks about Lean only as needed and never offers a mutator the project already has', async () => {
    const prompter = scripted(['', 'n', 'n', 'n']);
    const result = await runInitWizard(
      proposed,
      environment({ leanAvailable: async () => true, projectHasMutator: true }),
      prompter,
    );
    expect(prompter.questions.some((q) => q.includes('Install it with elan'))).toBe(false);
    expect(prompter.questions.some((q) => q.includes('Use Lean instead of Z3'))).toBe(true);
    expect(prompter.questions.some((q) => q.includes('@mizchi/mutator'))).toBe(false);
    expect(result.config.formal.backend).toBe('z3');
  });

  it('keeps GitHub off without a valid repository', async () => {
    const result = await runInitWizard(
      proposed,
      environment({ githubRepo: () => null }),
      scripted(['', 'y', 'not a repo', '']),
    );
    expect(result.config.sources.github.enabled).toBe(false);
  });
});

describe('init outside the questions', () => {
  it('never asks with --json or in CI', () => {
    expect(asksQuestions(undefined, {})).toBe(true);
    expect(asksQuestions(true, {})).toBe(false);
    expect(asksQuestions(undefined, { CI: 'true' })).toBe(false);
  });

  it('keeps proofs on Z3 when Lean cannot be installed, and goes on when the package manager fails', async () => {
    const lean = { ...proposed, formal: { ...proposed.formal, backend: 'lean' as const } };
    const ran: string[][] = [];
    const tools = {
      installLean: async () => false,
      leanAvailable: async () => false,
      run: async (command: string, args: string[]) => {
        ran.push([command, ...args]);

        return false;
      },
    };
    const next = await perform(
      [
        { kind: 'install-lean' },
        { kind: 'add-mutator', command: ['pnpm', 'add', '-D', '@mizchi/mutator@0.4.5'] },
      ],
      lean,
      '/p',
      tools,
    );
    expect(next.formal.backend).toBe('z3');
    expect(ran).toEqual([['pnpm', 'add', '-D', '@mizchi/mutator@0.4.5']]);
    const kept = await perform([{ kind: 'install-lean' }], lean, '/p', {
      ...tools,
      installLean: async () => true,
      leanAvailable: async () => true,
    });
    expect(kept.formal.backend).toBe('lean');
  });
});

describe('helpers', () => {
  it('reads the GitHub repository of the origin remote', () => {
    expect(githubRepoFromRemote('git@github.com:acme/shop.git')).toBe('acme/shop');
    expect(githubRepoFromRemote('https://github.com/acme/shop')).toBe('acme/shop');
    expect(githubRepoFromRemote('https://gitlab.com/acme/shop.git')).toBeNull();
    expect(githubRepoFromRemote(null)).toBeNull();
    // Only github.com itself.
    expect(githubRepoFromRemote('https://evilgithub.com/acme/shop')).toBeNull();
    expect(githubRepoFromRemote('git@notgithub.com:acme/shop.git')).toBeNull();
    expect(githubRepoFromRemote('https://github.com.example.com/acme/shop')).toBeNull();
    expect(githubRepoFromRemote('ssh://git@github.com/acme/shop.git')).toBe('acme/shop');
  });

  it('runs the elan installer without its menu, without changing PATH, with the stable toolchain', () => {
    expect(installerCommand('/tmp/elan-init.sh', false)).toEqual([
      'sh',
      ['/tmp/elan-init.sh', '-y', '--default-toolchain', 'stable', '--no-modify-path'],
    ]);
    const [command, args] = installerCommand("C:\\Temp\\o'k\\elan-init.ps1", true);
    expect(command).toBe('powershell');
    expect(args.at(-1)).toBe(
      "& 'C:\\Temp\\o''k\\elan-init.ps1' -NoPrompt $true -NoModifyPath $true -DefaultToolchain stable",
    );
  });

  it('adds a dev dependency with the project package manager', () => {
    expect(addDevDependency('npm', 'x@1')).toEqual(['npm', 'install', '-D', 'x@1']);
    expect(addDevDependency('yarn', 'x@1')).toEqual(['yarn', 'add', '-D', 'x@1']);
    expect(addDevDependency('bun', 'x@1')).toEqual(['bun', 'add', '-d', 'x@1']);
    expect(addDevDependency('unknown', 'x@1')).toEqual(['npm', 'install', '-D', 'x@1']);
  });
});
