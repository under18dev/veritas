import { isCi } from '@under18dev/veritas-improvement';

interface Stream {
  isTTY?: boolean;
}

/**
 * Whether `veritas` should open the terminal user interface: no arguments at all, an interactive terminal on both
 * stdin and stdout, and not CI. Anything else keeps the previous behaviour (help on stderr, exit 2).
 */
export function shouldLaunchTui(
  argv: string[],
  stdin: Stream,
  stdout: Stream,
  env: NodeJS.ProcessEnv,
): boolean {
  return argv.length <= 2 && stdin.isTTY === true && stdout.isTTY === true && !isCi(env);
}
