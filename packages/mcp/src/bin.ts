#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TOOL_VERSION } from '@veritas/core';
import { createServer } from './server.js';

const { values } = parseArgs({
  options: {
    root: { type: 'string', default: process.cwd() },
    'max-concurrent': { type: 'string', default: '1' },
  },
});
const root = realpathSync(path.resolve(values.root as string));
const server = createServer({
  root,
  maxConcurrent: Math.max(1, Number(values['max-concurrent'])),
  version: TOOL_VERSION,
});
await server.connect(new StdioServerTransport());
process.stderr.write(`veritas-mcp serving ${root}\n`);
