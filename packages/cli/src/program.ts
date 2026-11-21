import { statSync } from 'node:fs';
import path from 'node:path';
import { ExitCode, TOOL_VERSION, VeritasError, withRunContext } from '@under18dev/veritas-core';
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
  testGenerateCommand,
  testReplayCommand,
} from './commands/engine.js';
import { improveCommand } from './commands/improve.js';
import { initCommand } from './commands/init.js';
import { configureLogging, emitJson, type GlobalOptions, reportError, stderrSink } from './output.js';
import { shouldLaunchTui } from './tui.js';

type Handler = (opts: GlobalOptions & Record<string, unknown>, args: string[]) => Promise<ExitCode>;

// A repeated option adds a value instead of replacing the previous one (Commander keeps only the last).
const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

/**
 * `writeOut` receives what Commander prints on stdout (help and the version); by default it goes to stdout.
 */
export function buildProgram(
  setExit: (code: ExitCode) => void,
  writeOut: (text: string) => void = (text) => process.stdout.write(text),
): Command {
  const program = new Command('veritas')
    .description('Specification-aware test verification for TypeScript/JavaScript projects')
    .version(TOOL_VERSION)
    .option('--json', 'print machine-readable JSON on stdout; logs go to stderr')
    .option('-C, --root <dir>', 'project root', process.cwd())
    .option('--allow-code-config', 'allow loading veritas.config.{ts,js,mjs}, which executes project code')
    .option(
      '--debug',
      'log child processes, restricted calls of project code, stages and cache use to stderr (also VERITAS_DEBUG=1)',
    )
    .addOption(
      new Option('--log-format <format>', 'stderr log format: text, or json (one object per line)')
        .choices(['text', 'json'])
        .default('text'),
    )
    .addHelpText(
      'after',
      '\nRun `veritas` without arguments in an interactive terminal to open the terminal user interface.',
    )
    .exitOverride()
    .configureOutput({ writeOut, writeErr: (s) => process.stderr.write(s) });

  const wire = (cmd: Command, handler: Handler) =>
    cmd.action(async (...actionArgs: unknown[]) => {
      const command = actionArgs[actionArgs.length - 1] as Command;
      const global = program.opts() as GlobalOptions;
      const opts = { ...global, ...command.opts(), root: path.resolve(global.root) } as GlobalOptions &
        Record<string, unknown>;
      configureLogging({ debug: Boolean(global.debug), format: global.logFormat });

      try {
        if (!statSync(opts.root, { throwIfNoEntry: false })?.isDirectory())
          throw new VeritasError('user', 'ROOT_NOT_FOUND', `project root is not a directory: ${opts.root}`);
        // Library code reports through the run context; the CLI shows it on stderr.
        setExit(
          await withRunContext({ root: opts.root, sinks: [stderrSink] }, () => handler(opts, command.args)),
        );
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
      .description(
        'check tools, credentials and the restricted runner for project code; report disabled/degraded features',
      ),
    (o) => doctorCommand(o),
  );
  wire(
    program
      .command('discover')
      .description('collect specification evidence')
      .option('--offline', 'make no network requests: local sources only, no LLM')
      .addOption(new Option('--sources <list>', 'comma-separated: local,github,web,all').default('local'))
      .option('--allow-domain <domain...>', 'allow a web domain (also needs sources.web.enabled in config)')
      .option('--max-pages <n>', 'web page budget'),
    (o) => discoverCommand(o),
  );
  const spec = program.command('spec').description('review the property registry');
  wire(spec.command('list').description('list properties of the latest run'), (o) =>
    specCommand(o, 'list', []),
  );
  wire(
    spec.command('show <id>').description('show a property, its sources and the decisions recorded for it'),
    (o, a) => specCommand(o, 'show', a),
  );
  wire(
    spec
      .command('accept <id>')
      .description('accept a property as the specification (recorded in .veritas/approvals.json)')
      .requiredOption('--reason <text>', 'reason recorded with the decision')
      .option('--actor <name>', 'who decides (default: VERITAS_ACTOR, then git user.name)'),
    (o, a) => specCommand(o, 'accept', a),
  );
  wire(
    spec
      .command('reject <id>')
      .description('reject a property (recorded in .veritas/approvals.json)')
      .requiredOption('--reason <text>', 'reason recorded with the decision')
      .option('--actor <name>', 'who decides (default: VERITAS_ACTOR, then git user.name)'),
    (o, a) => specCommand(o, 'reject', a),
  );
  wire(spec.command('diff').description('compare properties of the last two runs'), (o) =>
    specCommand(o, 'diff', []),
  );
  wire(spec.command('export').description('print the registry as JSON'), (o) => specCommand(o, 'export', []));
  wire(
    program
      .command('analyze [path]')
      .description('index code and tests, map them to properties and assess tests (only [path], if given)')
      .option('--since <ref>', 'mark candidates in code changed since this git ref'),
    (o, a) => analyzeCommand(o, a),
  );
  wire(
    program
      .command('mutate')
      .description('run mutation testing and relate mutants to properties')
      .option('--since <ref>', 'mutate only code changed since this git ref')
      .option('--scope <glob>', 'mutate only files matching this glob (repeatable)', collect)
      .option(
        '--import <file>',
        'normalize an existing mutation-testing-elements report instead of running mutator',
      )
      .option(
        '--kill-matrix',
        'run every covering test for every mutant and report the kill matrix (slower)',
      ),
    (o) => mutateCommand(o),
  );
  const testCommand = program.command('test').description('property-based tests');
  wire(
    testCommand
      .command('replay <pbt-id>')
      .description(
        'replay a recorded property-based test with its seed and shrink path; exit 0 when the recorded result is reproduced, 4 when it is not',
      )
      .option('--run <run-id>', 'look in this run instead of the most recent ones'),
    (o, a) => testReplayCommand(o, a),
  );
  wire(
    testCommand
      .command('generate')
      .description(
        'generate fast-check property tests for formalized properties (written under .veritas/generated-tests)',
      )
      .option('--property <id>', 'generate a test for this property only')
      .option('--dry-run', 'print instead of writing')
      .option('--force', 'replace generated files that were changed since they were written'),
    (o) => testGenerateCommand(o),
  );
  wire(
    program
      .command('prove')
      .description('verify formalized properties with an SMT solver (bounded)')
      .option('--property <id>', 'verify this property only (repeatable)', collect)
      .option('--include-proposed', 'also check properties that are not accepted (experimental)')
      .addOption(
        new Option(
          '--engine <engine>',
          'z3 (bounded checks), lean (kernel-checked proofs) or both (default: formal.backend in the configuration)',
        ).choices(['z3', 'lean', 'both']),
      ),
    (o) => proveCommand(o),
  );
  wire(
    program
      .command('improve')
      .description(
        'plan test-only improvements (dry run, the default) or apply an approved plan in an isolated copy; ' +
          'exit 0 plan ready/improved, 4 no safe improvement or spec decision needed, 1 blocked, 2 bad token or CI, 3 tool error',
      )
      .option('--include-proposed', 'also use proposed (not yet accepted) properties as the oracle')
      .option('--dry-run', 'plan and print the plan and its approval token; never writes project files')
      .option('--apply', 'apply an approved plan (needs --plan and --approve; refused in CI)')
      .option('--plan <id>', 'plan id printed by the dry run')
      .option('--approve <token>', 'approval token printed by the dry run')
      .option(
        '--actor <name>',
        'who approves, recorded with the plan (default: VERITAS_ACTOR, then git user.name)',
      )
      .option('--run <run-id>', 'plan from this run instead of the latest one')
      .option('--max-iterations <n>', 'maximum apply attempts for the plan (1-20)'),
    (o) => improveCommand(o),
  );
  wire(
    program
      .command('report')
      .description('print the latest results')
      .addOption(
        new Option('--format <format>', 'output format (default: text, or json with --json)').choices([
          'text',
          'json',
          'markdown',
          'html',
          'sarif',
        ]),
      )
      .option('--run <run-id>', 'report on this run instead of the latest'),
    (o) => reportCommand(o),
  );
  wire(
    program
      .command('run')
      .description('run the full pipeline')
      .addOption(
        new Option(
          '--profile <profile>',
          'quick (no project code), standard (+ mutation) or deep (+ property tests and proofs)',
        )
          .choices(['quick', 'standard', 'deep'])
          .default('standard'),
      )
      .option(
        '--offline',
        'Veritas makes no network requests (sources, LLM); project tests still run as with `pnpm test`',
      )
      .option('--since <ref>', 'limit mutation to code changed since this git ref')
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
  if (shouldLaunchTui(argv, process.stdin, process.stdout, process.env)) {
    // Loaded only here, so the other commands do not pay for React and Ink at startup.
    const { startTui } = await import('@under18dev/veritas-tui');

    return (await startTui({ root: process.cwd() })) as ExitCode;
  }
  let exitCode: ExitCode = ExitCode.Success;
  const json = argv.includes('--json');
  // With --json, help and the version are collected and printed as one JSON object, keeping stdout pure JSON.
  let out = '';
  const program = buildProgram(
    (code) => {
      exitCode = code;
    },
    json
      ? (text) => {
          out += text;
        }
      : undefined,
  );
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) {
        if (json && out)
          emitJson(
            error.code === 'commander.version'
              ? { status: 'ok', version: out.trim() }
              : { status: 'ok', help: out },
          );
        return ExitCode.Success;
      }
      // Usage errors (unknown command or option, invalid choice) are user errors; with --json they are JSON too.
      if (json)
        emitJson({
          status: 'error',
          category: 'user',
          code: 'USAGE',
          message: error.message.replace(/^error: /, ''),
          hint: 'run `veritas --help`',
          exitCode: ExitCode.UserError,
        });

      return ExitCode.UserError;
    }
    return reportError(error, json);
  }

  return exitCode;
}
