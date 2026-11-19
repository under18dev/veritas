import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI, REPO_ROOT } from './helpers.js';

const MCP = path.join(REPO_ROOT, 'packages/mcp/dist/bin.js');

interface Help {
  flags: Set<string>;
  /** Allowed values of options that declare `choices`. */
  choices: Map<string, string[]>;
  subcommands: string[];
}

function parseHelp(text: string): Help {
  const flags = new Set<string>();
  const choices = new Map<string, string[]>();
  const subcommands: string[] = [];
  let section = '';
  const entries: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^[A-Z][a-z]+:/.test(line)) {
      section = line;
      continue;
    }
    if (section.startsWith('Commands:')) {
      const name = /^ {2}([a-z][a-z-]*)/.exec(line)?.[1];
      if (name && name !== 'help') subcommands.push(name);
    } else if (/^ {2}-/.test(line)) entries.push(line);
    else if (/^ {4,}\S/.test(line) && entries.length > 0) entries[entries.length - 1] += ` ${line.trim()}`;
  }
  // Usage lines of hand-written help (veritas-mcp) list options in brackets.
  for (const usage of text.matchAll(/\[(--[a-z][a-z-]*)[^\]]*\]/g)) flags.add(usage[1] as string);
  for (const entry of entries) {
    for (const flag of entry.matchAll(/(?:^|[\s,])(--[a-z][a-z-]*)/g)) flags.add(flag[1] as string);
    const declared = /^\s+(?:-\w, )?(--[a-z][a-z-]*)/.exec(entry)?.[1];
    const values = /\(choices: ([^)]*?)(?:, default:|\))/.exec(entry)?.[1];
    if (declared && values) choices.set(declared, [...values.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string));
  }
  return { flags, choices, subcommands };
}

function help(bin: string, args: string[]): Help {
  const result = spawnSync(process.execPath, [bin, ...args, '--help'], { encoding: 'utf8' });
  expect(result.status, `${args.join(' ')} --help\n${result.stderr}`).toBe(0);
  return parseHelp(result.stdout);
}

interface Invocation {
  text: string;
  command: string[];
  rest: string[];
}

/** Every `veritas <command> ...` in code blocks and inline code, up to a comment, redirect or closing backtick. */
function invocations(markdown: string, top: Help): Invocation[] {
  const out: Invocation[] = [];
  for (const match of markdown.matchAll(/(?:^|[\s`])veritas ([^`\n#>]*)/gm)) {
    const tokens = (match[1] as string).trim().split(/\s+/).filter(Boolean);
    const [first, ...others] = tokens;
    if (!first || !/^[a-z]/.test(first)) continue;
    expect(top.subcommands, `unknown subcommand in "${match[0].trim()}"`).toContain(first);
    const command = [first];
    const nested = help(CLI, command).subcommands;
    if (nested.length > 0) {
      const child = others.shift();
      expect(nested, `unknown subcommand in "${match[0].trim()}"`).toContain(child);
      command.push(child as string);
    }
    out.push({ text: match[0].trim(), command, rest: others });
  }
  return out;
}

describe('the Agent Skill matches the CLI', () => {
  const skill = readFileSync(path.join(REPO_ROOT, 'skills/veritas/SKILL.md'), 'utf8');
  const top = help(CLI, []);

  it('uses only subcommands, options and option values that the CLI accepts', () => {
    const found = invocations(skill, top);
    // Sanity check that the parser sees the documented workflow.
    expect(found.map((i) => i.command.join(' '))).toEqual(
      expect.arrayContaining(['init', 'doctor', 'run', 'report', 'explain', 'spec list', 'improve', 'spec accept']),
    );
    for (const invocation of found) {
      const accepted = help(CLI, invocation.command);
      for (const [index, token] of invocation.rest.entries()) {
        if (!token.startsWith('--')) continue;
        const flag = token.split('=')[0] as string;
        expect(
          accepted.flags.has(flag) || top.flags.has(flag),
          `"${invocation.text}": veritas ${invocation.command.join(' ')} does not accept ${flag}`,
        ).toBe(true);
        const allowed = accepted.choices.get(flag);
        const value = invocation.rest[index + 1];
        if (allowed && value && !value.startsWith('<'))
          for (const choice of value.split('|'))
            expect(allowed, `"${invocation.text}": ${flag} ${choice}`).toContain(choice);
      }
    }
  });

  it('mentions only options that some veritas or veritas-mcp command accepts', () => {
    const known = new Set<string>([...top.flags, ...help(MCP, []).flags]);
    const queue = top.subcommands.map((name) => [name]);
    for (let command = queue.shift(); command; command = queue.shift()) {
      const current = help(CLI, command);
      for (const flag of current.flags) known.add(flag);
      for (const child of current.subcommands) queue.push([...command, child]);
    }
    const mentioned = [...new Set([...skill.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)].map((m) => m[0]))];
    expect(mentioned.length).toBeGreaterThan(5);
    expect(mentioned.filter((flag) => !known.has(flag))).toEqual([]);
  });

  it('documents veritas-mcp with options the server accepts', () => {
    const accepted = help(MCP, []);
    const calls = [...skill.matchAll(/veritas-mcp((?: [^`\n]*)?)/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls)
      for (const flag of (call[1] as string).matchAll(/--[a-z][a-z-]*/g))
        expect(accepted.flags, call[0]).toContain(flag[0]);
  });
});
