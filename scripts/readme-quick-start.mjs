// Reads the `veritas` commands of the README quick start, so the clean install check runs exactly what users are
// told to run.
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The arguments of every `veritas` invocation in the first code block under the "Quick start" heading, in order.
 * An invocation is `veritas <args>` or `node <path>/packages/cli/dist/bin.js <args>`. Placeholders such as
 * `<finding-id>` are kept for the caller to fill in.
 * @param {string} markdown
 * @returns {string[][]}
 */
export function quickStartCommands(markdown) {
  const section = markdown.split(/^## /m).find((part) => /^Quick start\b/i.test(part));

  if (!section) throw new Error('README has no "Quick start" section');
  const block = /```[a-z]*\r?\n([\s\S]*?)```/.exec(section)?.[1];

  if (!block) throw new Error('README quick start has no code block');
  const commands = [];

  for (const line of block.split(/\r?\n/)) {
    const args =
      /^\s*(?:npx\s+|pnpm\s+exec\s+)?(?:veritas|node\s+\S*packages\/cli\/dist\/bin\.js)\s+(.*)$/.exec(
        line,
      )?.[1];

    if (args)
      commands.push(
        args
          .replace(/\s+#.*$/, '')
          .trim()
          .split(/\s+/),
      );
  }

  if (commands.length === 0) throw new Error('README quick start runs no veritas command');

  return commands;
}

/** @param {string} repo */
export function readmeQuickStart(repo) {
  return quickStartCommands(readFileSync(path.join(repo, 'README.md'), 'utf8'));
}
