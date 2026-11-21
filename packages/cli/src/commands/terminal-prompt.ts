import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { log } from '../output.js';
import { type Prompter, withTypedChoices } from './init-wizard.js';

/** The user pressed Ctrl+C at a question. */
export class PromptAborted extends Error {
  constructor() {
    super('aborted at a question');
  }
}

interface Key {
  name?: string;
  ctrl?: boolean;
}

/** Columns a character takes: two for wide East Asian characters and emoji, and for the marks drawn here. */
function charWidth(code: number): number {
  return (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd) ||
    // Ambiguous width: two columns in some East Asian terminals, so counted as two to stay on one line.
    code === 0x276f
    ? 2
    : 1;
}

/** `text` cut to fit in `columns`, so a redrawn line never wraps and the cursor math stays exact. */
export function fitColumns(text: string, columns: number): string {
  let width = 0;
  let out = '';

  for (const char of text) {
    const w = charWidth(char.codePointAt(0) ?? 0);

    if (width + w > columns) return `${out.slice(0, -1)}…`;
    width += w;
    out += char;
  }

  return out;
}

/**
 * Questions on the terminal: choices and yes/no questions are picked with the arrow keys (or j/k, a number, y/n)
 * and Enter. When stdin or stderr is not a terminal, they are answered by typing instead.
 */
export function terminalPrompter(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stderr,
): Prompter {
  const ask = async (question: string): Promise<string> => {
    // A fresh interface per question, so it never competes with the raw-mode key reading of `pick`.
    const rl = createInterface({ input, output });
    const abort = new AbortController();
    rl.on('SIGINT', () => abort.abort());

    try {
      return await rl.question(question, { signal: abort.signal });
    } catch (error) {
      throw abort.signal.aborted ? new PromptAborted() : error;
    } finally {
      rl.close();
    }
  };
  const typed = withTypedChoices({ ask, say: log });

  if (!input.isTTY || !output.isTTY) return typed;
  const color = !process.env.NO_COLOR && (output.hasColors?.() ?? true);
  const paint = (code: string, text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);

  // The question is written once and may wrap; only the choice lines below it are redrawn, each cut to the width.
  const pick = (
    question: string,
    choices: string[],
    initial: number,
    shortcuts: Record<string, number> = {},
  ): Promise<number> =>
    new Promise((resolve, reject) => {
      const wasRaw = input.isRaw;
      let index = initial;
      let drawn = 0;

      const draw = () => {
        const width = Math.max(10, (output.columns || 80) - 1);
        const lines = choices.map((c, i) =>
          i === index ? paint('36', fitColumns(`❯ ${c}`, width)) : fitColumns(`  ${c}`, width),
        );
        output.write(`${drawn ? `\x1b[${drawn}A\r\x1b[0J` : ''}${lines.join('\n')}\n`);
        drawn = lines.length;
      };

      const finish = (result: string) => {
        input.off('keypress', onKey);
        input.off('end', onEnd);
        input.setRawMode(wasRaw);
        input.pause();
        output.write(`\x1b[${drawn}A\r\x1b[0J\x1b[?25h${result}\n`);
      };
      const abort = () => {
        finish(`  ${paint('31', '✖')} stopped`);
        reject(new PromptAborted());
      };
      const onEnd = () => abort();

      const onKey = (text: string | undefined, key: Key | undefined) => {
        if (key?.ctrl && (key.name === 'c' || key.name === 'd')) return abort();
        const shortcut = text ? shortcuts[text.toLowerCase()] : undefined;
        const digit = text && /^[1-9]$/.test(text) ? Number(text) - 1 : -1;

        if (key?.name === 'up' || key?.name === 'k') index = (index + choices.length - 1) % choices.length;
        else if (key?.name === 'down' || key?.name === 'j' || key?.name === 'tab')
          index = (index + 1) % choices.length;
        else if (digit >= 0 && digit < choices.length) index = digit;
        // A shortcut only moves the highlight, so the Enter that follows it does not answer the next question.
        else if (shortcut !== undefined) index = shortcut;
        else if (key?.name === 'return' || key?.name === 'enter') {
          finish(`  ${paint('32', '✔')} ${paint('36', choices[index] ?? '')}`);
          resolve(index);

          return;
        } else return;
        draw();
      };

      emitKeypressEvents(input);
      input.setRawMode(true);
      input.resume();
      input.on('keypress', onKey);
      // stdin closing (Ctrl+D at the shell level, a closed pipe) stops instead of waiting forever.
      input.once('end', onEnd);
      output.write(
        `${paint('36', '?')} ${paint('1', question)} ${paint('2', '(↑/↓ to move, Enter to choose)')}\n\x1b[?25l`,
      );
      draw();
    });

  return {
    ask,
    say: log,
    select: (question, choices, initial = 0) => pick(question, choices, initial),
    confirm: async (question, initial = false) =>
      (await pick(question, ['Yes', 'No'], initial ? 0 : 1, { y: 0, n: 1 })) === 0,
  };
}
