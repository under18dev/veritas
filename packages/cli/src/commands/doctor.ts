import { ExitCode, loadConfig, type VeritasConfig, VeritasError } from '@under18dev/veritas-core';
import { bundledTools, runDoctor } from '@under18dev/veritas-engine';
import { emitJson, emitText, type GlobalOptions, log } from '../output.js';

export async function doctorCommand(opts: GlobalOptions): Promise<ExitCode> {
  let config: VeritasConfig | null = null;

  try {
    config = (await loadConfig(opts.root, { allowCodeConfig: opts.allowCodeConfig })).config;
  } catch (error) {
    if (!(error instanceof VeritasError) || error.code !== 'CONFIG_MISSING') throw error;
    log('no configuration found; checking with defaults (run `veritas init`)');
  }
  const report = await runDoctor(opts.root, config, process.env, bundledTools());
  const nodeOk = report.capabilities.find((c) => c.name === 'node')?.state === 'available';

  if (opts.json) {
    emitJson({ status: nodeOk ? 'ok' : 'unusable', configFound: config !== null, ...report });
  } else {
    for (const c of report.capabilities)
      emitText(`${c.state.padEnd(11)} ${c.name.padEnd(16)} ${c.version ?? ''} ${c.detail}`);
    emitText('');

    for (const f of report.features)
      emitText(
        `${f.state.padEnd(9)} ${f.feature}${f.missing.length ? ` (missing: ${f.missing.join(', ')})` : ''}${f.partial?.length ? ` (partial: ${f.partial.join(', ')})` : ''}`,
      );
  }

  return nodeOk ? ExitCode.Success : ExitCode.ToolError;
}
