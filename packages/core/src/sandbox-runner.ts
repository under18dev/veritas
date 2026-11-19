// Executed in a child Node.js process under the permission model. Reads a JSON job from stdin,
// imports one module, calls one export with each argument list, and prints encoded results.
import { pathToFileURL } from 'node:url';

type Encoded =
  | { t: 'number'; v: string }
  | { t: 'boolean'; v: boolean }
  | { t: 'string'; v: string }
  | { t: 'bigint'; v: string }
  | { t: 'undefined' }
  | { t: 'null' }
  | { t: 'other'; v: string }
  | { t: 'throw'; v: string };

function encode(value: unknown): Encoded {
  if (typeof value === 'number') return { t: 'number', v: Object.is(value, -0) ? '-0' : String(value) };
  if (typeof value === 'boolean') return { t: 'boolean', v: value };
  if (typeof value === 'string') return { t: 'string', v: value };
  if (typeof value === 'bigint') return { t: 'bigint', v: value.toString() };
  if (value === undefined) return { t: 'undefined' };
  if (value === null) return { t: 'null' };
  return { t: 'other', v: Object.prototype.toString.call(value) };
}

function decode(arg: Encoded): unknown {
  switch (arg.t) {
    case 'number':
      return arg.v === '-0' ? -0 : Number(arg.v);
    case 'boolean':
    case 'string':
      return arg.v;
    case 'bigint':
      return BigInt(arg.v);
    case 'null':
      return null;
    default:
      return undefined;
  }
}

let input = '';
for await (const chunk of process.stdin) input += chunk;
const job = JSON.parse(input) as { module: string; exportName: string; calls: Encoded[][] };
const mod = (await import(pathToFileURL(job.module).href)) as Record<string, unknown>;
const fn = mod[job.exportName];
if (typeof fn !== 'function') {
  process.stdout.write(JSON.stringify({ ok: false, error: `export ${job.exportName} is not a function` }));
} else {
  const results = job.calls.map((args) => {
    try {
      return encode((fn as (...a: unknown[]) => unknown)(...args.map(decode)));
    } catch (error) {
      return {
        t: 'throw',
        v: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      } as Encoded;
    }
  });
  process.stdout.write(JSON.stringify({ ok: true, results }));
}
