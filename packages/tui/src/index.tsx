import { render } from 'ink';
import { App } from './App.js';
import { createApi, type TuiApi } from './api.js';

export type { ConfigFile, RunRequest, TuiApi } from './api.js';
export { createApi } from './api.js';

export interface TuiOptions {
  root: string;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  /** Replace the functions the screens call (tests). */
  api?: TuiApi;
}

/** Open the terminal user interface on a project and resolve with the exit code once the user quits. */
export async function startTui(options: TuiOptions): Promise<number> {
  const instance = render(<App api={options.api ?? createApi(options.root)} />, {
    ...(options.stdin ? { stdin: options.stdin } : {}),
    ...(options.stdout ? { stdout: options.stdout } : {}),
    exitOnCtrlC: true,
  });

  await instance.waitUntilExit();

  return 0;
}
