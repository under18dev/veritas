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

const color = !process.env.NO_COLOR;
const paint = (code: string, text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);

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

  /** Terminal rows `text` takes, counting lines the terminal wraps. */
  const rowsOf = (text: string) => {
    const columns = output.columns || 80;

    return text.split('\n').reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / columns)), 0);
  };

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
      const hint = paint('2', '(↑/↓ to move, Enter to choose)');

      const draw = () => {
        const plain = [`? ${question} (↑/↓ to move, Enter to choose)`, ...choices.map((c) => `  ${c}`)];
        const lines = [
          `${paint('36', '?')} ${paint('1', question)} ${hint}`,
          ...choices.map((c, i) => (i === index ? paint('36', `❯ ${c}`) : `  ${c}`)),
        ];
        output.write(`${drawn ? `\x1b[${drawn}A\r\x1b[0J` : ''}${lines.join('\n')}\n`);
        drawn = rowsOf(plain.join('\n'));
      };

      const finish = () => {
        input.off('keypress', onKey);
        input.setRawMode(wasRaw);
        input.pause();
        output.write(`\x1b[${drawn}A\r\x1b[0J\x1b[?25h`);
      };

      const onKey = (text: string | undefined, key: Key | undefined) => {
        if (key?.ctrl && key.name === 'c') {
          finish();
          output.write(`${paint('31', '✖')} ${question}\n`);
          reject(new PromptAborted());

          return;
        }
        const shortcut = text ? shortcuts[text.toLowerCase()] : undefined;
        const digit = text && /^[1-9]$/.test(text) ? Number(text) - 1 : -1;

        if (key?.name === 'up' || key?.name === 'k') index = (index + choices.length - 1) % choices.length;
        else if (key?.name === 'down' || key?.name === 'j' || key?.name === 'tab')
          index = (index + 1) % choices.length;
        else if (digit >= 0 && digit < choices.length) index = digit;
        else if (shortcut !== undefined || key?.name === 'return' || key?.name === 'enter') {
          const chosen = shortcut ?? index;
          finish();
          output.write(`${paint('32', '✔')} ${question} ${paint('36', choices[chosen] ?? '')}\n`);
          resolve(chosen);

          return;
        } else return;
        draw();
      };

      emitKeypressEvents(input);
      input.setRawMode(true);
      input.resume();
      input.on('keypress', onKey);
      output.write('\x1b[?25l');
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
