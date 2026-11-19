import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';

interface Z3Low {
  get_full_version(): string;
  mk_config(): unknown;
  mk_context(cfg: unknown): unknown;
  del_config(cfg: unknown): void;
  eval_smtlib2_string(ctx: unknown, smt: string): Promise<string>;
}

const require = createRequire(import.meta.url);
const { init } = require('z3-solver') as { init(): Promise<{ Z3: Z3Low }> };

try {
  const { Z3 } = await init();
  const cfg = Z3.mk_config();
  const ctx = Z3.mk_context(cfg);
  Z3.del_config(cfg);
  const output = await Z3.eval_smtlib2_string(ctx, (workerData as { smt: string }).smt);
  parentPort?.postMessage({ ok: true, output, version: Z3.get_full_version() });
} catch (error) {
  parentPort?.postMessage({ ok: false, error: (error as Error).message ?? String(error) });
}
