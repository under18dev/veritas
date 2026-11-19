// Regenerates schemas/*.json from the Zod definitions in @under18dev/veritas-core. Run via `pnpm schemas`.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportJsonSchemas } from '../packages/core/dist/index.js';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schemas');
mkdirSync(out, { recursive: true });
for (const [name, schema] of Object.entries(exportJsonSchemas())) {
  writeFileSync(path.join(out, `${name}.json`), `${JSON.stringify(schema, null, 2)}\n`);
}
