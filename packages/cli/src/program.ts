import path from 'node:path';
import { ExitCode, TOOL_VERSION } from '@veritas/core';
import { Command, CommanderError, Option } from 'commander';
import { doctorCommand } from './commands/doctor.js';
import {
  analyzeCommand,
  discoverCommand,
  explainCommand,
  mutateCommand,
  proveCommand,
  replayCommand,
  reportCommand,
  runCommandCli,
  specCommand,
} from './commands/engine.js';
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
      .option('--allow-domain <domain...>', 'allow a web domain (also needs sources.web.enabled in config)')
      .option('--max-pages <n>', 'web page budget'),
    (o) => discoverCommand(o),
  );
  const spec = program.command('spec').description('review the property registry');
  wire(spec.command('list').description('list properties of the latest run'), (o) =>
    specCommand(o, 'list', []),
  );
  wire(spec.command('show <id>'), (o, a) => specCommand(o, 'show', a));
  wire(
    spec
      .command('accept <id>')
      .requiredOption('--reason <text>', 'why')
      .option('--actor <name>', 'who decides (default: git user.name)'),
    (o, a) => specCommand(o, 'accept', a),
  );
  wire(
    spec
      .command('reject <id>')
      .requiredOption('--reason <text>', 'why')
      .option('--actor <name>', 'who decides (default: git user.name)'),
    (o, a) => specCommand(o, 'reject', a),
  );
  wire(spec.command('diff').description('compare properties of the last two runs'), (o) =>
    specCommand(o, 'diff', []),
  );
  wire(spec.command('export').description('print the registry as JSON'), (o) => specCommand(o, 'export', []));
  wire(
    program
      .command('analyze [path]')
      .description('index code and tests, map them to properties and assess tests')
      .option('--since <ref>'),
    (o, a) => analyzeCommand(o, a),
  );
  wire(
    program
      .command('mutate')
      .description('run mutation testing and relate mutants to properties')
      .option('--since <ref>')
      .option('--scope <glob>'),
    (o) => mutateCommand(o),
  );
  wire(
    program.command('test').command('generate').option('--property <id>').option('--dry-run'),
    notImplemented('test generate'),
  );
  wire(
    program
      .command('prove')
      .description('verify formalized properties with an SMT solver (bounded)')
      .option('--property <id>')
      .option('--include-proposed', 'also check properties that are not accepted (experimental)')
      .addOption(new Option('--engine <engine>').choices(['z3', 'lean']).default('z3')),
    (o) => proveCommand(o),
  );
  wire(
    program.command('improve').option('--dry-run').option('--apply').option('--max-iterations <n>'),
    notImplemented('improve'),
  );
  wire(
    program
      .command('report')
      .description('print the latest results')
      .addOption(new Option('--format <format>').choices(['text', 'json', 'markdown', 'html', 'sarif'])),
    (o) => reportCommand(o),
  );
  wire(
    program
      .command('run')
      .description('run the full pipeline')
      .addOption(new Option('--profile <profile>').choices(['quick', 'standard', 'deep']).default('standard'))
      .option('--offline', 'never access the network')
      .option('--since <ref>')
      .option('--include-proposed', 'also verify properties that are not accepted (experimental)'),
    (o) => runCommandCli(o),
  );
  wire(
    program.command('replay <run-id>').description('re-run a previous run with the same stages and options'),
    (o, a) => replayCommand(o, a),
  );
  wire(program.command('explain <finding-id>').description('show the evidence chain of a finding'), (o, a) =>
    explainCommand(o, a),
  );
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
