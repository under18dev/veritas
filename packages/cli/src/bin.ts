#!/usr/bin/env node
import { main } from './program.js';

// A reader that stops early (`veritas spec list | head -1`) closes the pipe; that is not an error of Veritas.
for (const stream of [process.stdout, process.stderr])
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(process.exitCode ?? 0);
    throw error;
  });

process.exitCode = await main(process.argv);
