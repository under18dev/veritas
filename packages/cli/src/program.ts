import path from 'node:path';
import { ExitCode, TOOL_VERSION } from '@veritas/core';
import { Command, CommanderError, Option } from 'commander';
import { doctorCommand } from './commands/doctor.js';
import { initCommand } from './commands/init.js';
import { emitJson, type GlobalOptions, log, reportError } from './output.js';

type Handler = (opts: GlobalOptions & Record<string, unknown>, args: string[]) => Promise<ExitCode>;

/** Commands that are part of the public surface but not implemented in this build. They fail loudly, never fake success. */
function notImplemented(name: string): Handler {
  return async (opts) => {
    const body = {
      status: 'unsupported',
      command: name,
      message: `\`veritas ${name}\` is not implemented in this build`,
    };
    opts.json
      ? emitJson({ ...body, exitCode: ExitCode.ToolError })
      : log(`error[NOT_IMPLEMENTED]: ${body.message}`);
    return ExitCode.ToolError;
  };
}

export function buildProgram(setExit: (code: ExitCode) => void): Command {
  const program = new Command('veritas')
    .description('Specification-aware test verification for TypeScript/JavaScript projects')
    .version(TOOL_VERSION)
    .option('--json', 'print machine-readable JSON on stdout; logs go to stderr')
    .option('-C, --root <dir>', 'project root', process.cwd())
    .option('--allow-code-config', 'allow loading veritas.config.{ts,js}, which executes project code')
    .exitOverride()
    .configureOutput({ writeErr: (s) => process.stderr.write(s) });

  const wire = (cmd: Command, handler: Handler) =>
    cmd.action(async (...actionArgs: unknown[]) => {
      const command = actionArgs[actionArgs.length - 1] as Command;
      const global = program.opts() as GlobalOptions;
      const opts = { ...global, ...command.opts(), root: path.resolve(global.root) } as GlobalOptions &
        Record<string, unknown>;
      try {
        setExit(await handler(opts, command.args));
      } catch (error) {
        setExit(reportError(error, opts.json));
      }
    });

  wire(
    program
      .command('init')
      .description('detect the project and write .veritas/config.json')
      .option('-y, --yes', 'non-interactive: accept the detected configuration')
      .option('--force', 'overwrite an existing configuration')
      .option('--dry-run', 'print the configuration without writing'),
    (o) => initCommand(o),
  );
  wire(
    program
      .command('doctor')
      .description('check tools, credentials and sandbox; report disabled/degraded features'),
    (o) => doctorCommand(o),
  );
  wire(
    program
      .command('discover')
      .description('collect specification evidence')
      .option('--offline', 'never access the network')
      .addOption(new Option('--sources <list>', 'comma-separated: local,github,web,all').default('local'))
      .option('--allow-domain <domain...>', 'allow a web domain')
      .option('--max-pages <n>', 'web page budget'),
    notImplemented('discover'),
  );
  const spec = program.command('spec').description('review the property registry');
  for (const sub of ['list', 'show <id>', 'accept <id>', 'reject <id>', 'diff', 'export']) {
    wire(spec.command(sub), notImplemented(`spec ${sub.split(' ')[0]}`));
  }
  wire(program.command('analyze [path]').option('--since <ref>'), notImplemented('analyze'));
  wire(program.command('mutate').option('--since <ref>').option('--scope <glob>'), notImplemented('mutate'));
  wire(
    program.command('test').command('generate').option('--property <id>').option('--dry-run'),
    notImplemented('test generate'),
  );
  wire(
    program
      .command('prove')
      .option('--property <id>')
      .addOption(new Option('--engine <engine>').choices(['z3', 'lean'])),
    notImplemented('prove'),
  );
  wire(
    program.command('improve').option('--dry-run').option('--apply').option('--max-iterations <n>'),
    notImplemented('improve'),
  );
  wire(
    program
      .command('report')
      .addOption(new Option('--format <format>').choices(['text', 'json', 'markdown', 'html', 'sarif'])),
    notImplemented('report'),
  );
  wire(
    program
      .command('run')
      .addOption(new Option('--profile <profile>').choices(['quick', 'standard', 'deep']))
      .option('--offline'),
    notImplemented('run'),
  );
  wire(program.command('replay <run-id>'), notImplemented('replay'));
  wire(program.command('explain <finding-id>'), notImplemented('explain'));
  return program;
}

export async function main(argv: string[]): Promise<ExitCode> {
  let exitCode: ExitCode = ExitCode.Success;
  const program = buildProgram((code) => {
    exitCode = code;
  });
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? ExitCode.Success : ExitCode.UserError;
    }
    return reportError(error, argv.includes('--json'));
  }
  return exitCode;
}
