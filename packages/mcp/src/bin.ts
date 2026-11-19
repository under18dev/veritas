#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TOOL_VERSION } from '@under18dev/veritas-core';
import { createServer } from './server.js';

const USAGE = `Usage: veritas-mcp [--root <dir>] [--max-concurrent <n>] [--allow-write]

Serves Veritas over MCP (stdio).
  --root <dir>          project root (default: current directory)
  --max-concurrent <n>  analysis jobs allowed at once (default: 1)
  --allow-write         register the tool that applies approved improvement plans
`;

let values: { root?: string; 'max-concurrent'?: string; 'allow-write'?: boolean; help?: boolean };
try {
  ({ values } = parseArgs({
    options: {
      root: { type: 'string', default: process.cwd() },
      'max-concurrent': { type: 'string', default: '1' },
      'allow-write': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }));
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
  process.exit(2);
}
if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
const root = realpathSync(path.resolve(values.root as string));
const server = createServer({
  root,
  maxConcurrent: Math.max(1, Number(values['max-concurrent'])),
  allowWrite: Boolean(values['allow-write']),
  version: TOOL_VERSION,
});
await server.connect(new StdioServerTransport());
process.stderr.write(`veritas-mcp serving ${root}\n`);
