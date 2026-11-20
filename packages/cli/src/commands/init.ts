import { createInterface } from 'node:readline/promises';
import { ExitCode, initProject, VeritasError } from '@under18dev/veritas-core';
import { emitJson, emitText, type GlobalOptions, log } from '../output.js';

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

  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      throw new VeritasError(
        'user',
        'CONFIRMATION_REQUIRED',
        'init needs confirmation in non-interactive mode',
        'pass --yes',
      );
    }
    log(JSON.stringify(preview.config, null, 2));
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await rl.question(`Write ${preview.file}? [y/N] `);
    rl.close();

    if (!/^y(es)?$/i.test(answer.trim())) {
      log('aborted; nothing written');

      return ExitCode.UserError;
    }
  }
  const result = initProject(opts.root, { force: opts.force });

  if (opts.json) {
    emitJson({ status: 'written', ...result });
  } else {
    emitText(`wrote ${result.file}`);
    emitText(
      `detected: package manager=${result.project.packageManager}, tsconfig=${result.project.tsconfig ?? 'none'}, vitest=${result.project.vitest.installedVersion ?? 'declared, not installed'}, git=${result.project.git}`,
    );
    emitText(`next:\n${result.nextSteps.map((s) => `  ${s}`).join('\n')}`);
  }

  return ExitCode.Success;
}
