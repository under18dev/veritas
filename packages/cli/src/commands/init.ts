import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ExitCode,
  gitOutput,
  llmAvailability,
  resolveCommand,
  resolvePackageVersion,
  type VeritasConfig,
  VeritasError,
} from '@under18dev/veritas-core';
import {
  bundledTools,
  detectProject,
  detectTestRunner,
  initProject,
  runDoctor,
  TEST_RUNNERS,
} from '@under18dev/veritas-engine';
import { isCi } from '@under18dev/veritas-improvement';
import { emitJson, emitText, type GlobalOptions, log } from '../output.js';
import { runInitWizard, type WizardAction, type WizardEnvironment } from './init-wizard.js';
import { PromptAborted, terminalPrompter } from './terminal-prompt.js';

/** `owner/name` of a GitHub `origin` remote (`git@github.com:o/n.git`, `https://github.com/o/n`). */
export function githubRepoFromRemote(url: string | null): string | null {
  // Only github.com itself, so `evilgithub.com` or `github.com.example` is never taken for it.
  const match =
    /^(?:https?:\/\/(?:[^@/\s]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
      url?.trim() ?? '',
    );

  return match ? `${match[1]}/${match[2]}` : null;
}

async function leanAvailable(root: string): Promise<boolean> {
  const report = await runDoctor(root, null, process.env, bundledTools());

  return report.capabilities.find((c) => c.name === 'lean')?.state === 'available';
}

/** Run a program with the user's terminal attached, so installers can show progress and ask their own questions. */
function runAttached(command: string, args: string[], cwd: string): Promise<boolean> {
  const resolved = resolveCommand(command);

  if (!resolved) return Promise.resolve(false);

  return new Promise((resolve) => {
    const child = spawn(resolved.command, [...resolved.prefix, ...args], { cwd, stdio: 'inherit' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

/**
 * How the official elan installer is run: without its menu, without changing PATH, with the stable toolchain.
 * `veritas doctor` finds Lean in ~/.elan/bin. PowerShell gets the booleans through -Command, since -File passes them
 * as strings.
 */
export function installerCommand(script: string, windows: boolean): [string, string[]] {
  return windows
    ? [
        'powershell',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `& '${script.replaceAll("'", "''")}' -NoPrompt $true -NoModifyPath $true -DefaultToolchain stable`,
        ],
      ]
    : ['sh', [script, '-y', '--default-toolchain', 'stable', '--no-modify-path']];
}

/** Download the official elan installer and run it; elan then installs the stable Lean 4 toolchain. */
async function installLean(root: string): Promise<boolean> {
  const windows = process.platform === 'win32';
  const url = `https://raw.githubusercontent.com/leanprover/elan/master/elan-init.${windows ? 'ps1' : 'sh'}`;
  const dir = mkdtempSync(path.join(tmpdir(), 'veritas-elan-'));

  try {
    const response = await fetch(url);

    if (!response.ok) {
      log(`could not download the elan installer (${response.status} from ${url})`);

      return false;
    }
    const script = path.join(dir, path.basename(url));
    writeFileSync(script, await response.text());

    return await runAttached(...installerCommand(script, windows), root);
  } catch (error) {
    log(`could not install Lean: ${(error as Error).message}`);

    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The runners detection found evidence for, as choices for the wizard: `Jest (jest.config.mjs, ...)`. */
function ambiguousRunners(root: string): NonNullable<WizardEnvironment['ambiguousTestRunners']> {
  return detectTestRunner(root)
    .installations.filter((installation) => installation.evidence.length > 0)
    .map((installation) => ({
      name: installation.name,
      label: `${TEST_RUNNERS.find((runner) => runner.name === installation.name)?.displayName ?? installation.name} (${installation.evidence.join(', ')})`,
    }));
}

/** Whether `init` asks its questions: only for a person at a terminal, never with --json or in CI. */
export function asksQuestions(json: boolean | undefined, env: NodeJS.ProcessEnv): boolean {
  return !json && !isCi(env);
}

export interface Installers {
  installLean(root: string): Promise<boolean>;
  leanAvailable(root: string): Promise<boolean>;
  run(command: string, args: string[], cwd: string): Promise<boolean>;
}

const installers: Installers = { installLean, leanAvailable, run: runAttached };

/** Carry out what the user agreed to; a failed Lean install puts proofs back on Z3. */
export async function perform(
  actions: WizardAction[],
  config: VeritasConfig,
  root: string,
  tools: Installers = installers,
): Promise<VeritasConfig> {
  const next = structuredClone(config);

  for (const action of actions) {
    if (action.kind === 'install-lean') {
      log('installing Lean 4 with elan...');
      const ok = (await tools.installLean(root)) && (await tools.leanAvailable(root));

      if (ok) log('Lean 4 is installed (in ~/.elan/bin, where `veritas doctor` also looks)');
      else {
        log('Lean 4 could not be installed; proofs stay on Z3. See https://lean-lang.org/install/');
        next.formal.backend = 'z3';
      }
    } else {
      log(`running ${action.command.join(' ')}...`);
      const [command, ...args] = action.command as [string, ...string[]];

      if (!(await tools.run(command, args, root)))
        log(`\`${action.command.join(' ')}\` failed; mutation testing uses the copy bundled with Veritas`);
    }
  }

  return next;
}

export async function initCommand(
  opts: GlobalOptions & { yes?: boolean; force?: boolean; dryRun?: boolean },
): Promise<ExitCode> {
  const preview = initProject(opts.root, { force: opts.force, dryRun: true });

  if (opts.dryRun) {
    opts.json
      ? emitJson({ status: 'dry_run', ...preview })
      : emitText(JSON.stringify(preview.config, null, 2));

    return ExitCode.Success;
  }
  let config = preview.config;
  let actions: WizardAction[] = [];
  const asked = { testRunner: false };

  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      throw new VeritasError(
        'user',
        'CONFIRMATION_REQUIRED',
        'init needs confirmation in non-interactive mode',
        'pass --yes',
      );
    }
    const prompter = terminalPrompter();

    try {
      // The questions are for a person at a terminal: never with --json or in CI.
      if (asksQuestions(opts.json, process.env)) {
        const env: WizardEnvironment = {
          project: detectProject(opts.root),
          llm: (provider, allowCodexFileReads = false) =>
            llmAvailability(provider, process.env, opts.root, { allowCodexFileReads }),
          leanAvailable: () => leanAvailable(opts.root),
          githubRepo: () => githubRepoFromRemote(gitOutput(opts.root, ['remote', 'get-url', 'origin'])),
          projectHasMutator: resolvePackageVersion(opts.root, '@mizchi/mutator') !== null,
          mutatorVersion: bundledTools()['@mizchi/mutator'] ?? null,
          ambiguousTestRunners: preview.testRunner.ambiguous ? ambiguousRunners(opts.root) : [],
        };
        ({ config, actions } = await runInitWizard(preview.config, env, prompter));
        asked.testRunner = (env.ambiguousTestRunners?.length ?? 0) > 1;
      }
      log(JSON.stringify(config, null, 2));

      for (const action of actions)
        log(
          action.kind === 'install-lean'
            ? 'then: install Lean 4 with elan'
            : `then: run ${action.command.join(' ')}`,
        );
      if (!(await prompter.confirm(`Write ${preview.file}?`))) {
        log('aborted; nothing written or installed');

        return ExitCode.UserError;
      }
    } catch (error) {
      if (!(error instanceof PromptAborted)) throw error;
      log('aborted; nothing written or installed');

      return ExitCode.UserError;
    }
    config = await perform(actions, config, opts.root);
  }
  const result = initProject(opts.root, {
    force: opts.force,
    config,
    testRunnerConfirmed: asked.testRunner,
  });

  if (opts.json) {
    emitJson({ status: 'written', ...result });
  } else {
    emitText(`wrote ${result.file}`);
    emitText(
      `detected: package manager=${result.project.packageManager}, tsconfig=${result.project.tsconfig ?? 'none'}, ${result.project.testRunner.name}=${result.project.testRunner.installedVersion ?? 'declared, not installed'}, git=${result.project.git}`,
    );
    emitText(
      `test runner: ${result.testRunner.name} (${result.testRunner.reason})${result.testRunner.ambiguous ? '; check analysis.testFramework' : ''}`,
    );
    emitText(`next:\n${result.nextSteps.map((s) => `  ${s}`).join('\n')}`);
  }

  return ExitCode.Success;
}
