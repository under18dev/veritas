import { createRequire } from 'node:module';

/**
 * Runs one SMT-LIB script through z3-solver (WebAssembly) in its own process: the script on stdin, one JSON line
 * on stdout. A separate process, not a worker thread, so a crash of the engine or of V8 ends only this process.
 */
interface Z3Low {
  get_full_version(): string;
  mk_config(): unknown;
  mk_context(cfg: unknown): unknown;
  del_config(cfg: unknown): void;
  eval_smtlib2_string(ctx: unknown, smt: string): Promise<string>;
}

const require = createRequire(import.meta.url);

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);

  return Buffer.concat(chunks).toString('utf8');
};

// z3-solver keeps its own threads alive, so the process exits explicitly once the result is written.
const finish = (result: object) => process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));

try {
  const smt = await readStdin();
  const { init } = require('z3-solver') as { init(): Promise<{ Z3: Z3Low }> };
  const { Z3 } = await init();
  const cfg = Z3.mk_config();
  const ctx = Z3.mk_context(cfg);
  Z3.del_config(cfg);
  const output = await Z3.eval_smtlib2_string(ctx, smt);
  finish({ ok: true, output, version: Z3.get_full_version() });
} catch (error) {
  finish({ ok: false, error: (error as Error).message ?? String(error) });
}
