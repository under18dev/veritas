import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { fitColumns, PromptAborted, terminalPrompter } from '../src/commands/terminal-prompt.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

/** A fake terminal: keys go in through `input`, the drawing comes out of `output`. */
function terminal(tty = true) {
  const input: PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(raw: boolean): unknown } =
    Object.assign(new PassThrough(), {
      isTTY: tty,
      isRaw: false,
      setRawMode: (raw: boolean) => {
        input.isRaw = raw;

        return input;
      },
    });
  const output = Object.assign(new PassThrough(), { isTTY: tty, columns: 80 });
  let written = '';
  output.on('data', (d: Buffer) => {
    written += d.toString();
  });
  const prompter = terminalPrompter(
    input as unknown as NodeJS.ReadStream,
    output as unknown as NodeJS.WriteStream,
  );
  const press = async (...keys: string[]) => {
    for (const key of keys) {
      input.write(key);
      await tick();
    }
  };

  return { prompter, press, input, written: () => written };
}

describe('terminal prompter', () => {
  it('moves with the arrow keys and answers on Enter', async () => {
    const { prompter, press } = terminal();
    const answer = prompter.select('Provider?', ['none', 'claude', 'codex']);
    await tick();
    await press('\u001B[B', '\u001B[B', '\u001B[A', '\r');
    expect(await answer).toBe(1);
  });

  it('takes y/n as a move, so the Enter after it answers the same question', async () => {
    const { prompter, press } = terminal();
    const first = prompter.confirm('First?');
    await tick();
    await press('y', '\r');
    expect(await first).toBe(true);
    let settled = false;
    const second = prompter.confirm('Second?').then((v) => {
      settled = true;

      return v;
    });
    await tick();
    expect(settled).toBe(false);
    await press('y', '\r');
    expect(await second).toBe(true);
  });

  it('restores the terminal after each question: raw mode, cursor and key listener', async () => {
    const { prompter, press, input, written } = terminal();
    const answer = prompter.confirm('Go on?');
    await tick();
    expect(input.isRaw).toBe(true);
    await press('\r');
    expect(await answer).toBe(false);
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount('keypress')).toBe(0);
    // The cursor is shown again, then the answer replaces the choices (colors aside).
    const out = written();
    const shown = out.lastIndexOf('\u001B[?25h');
    expect(shown).toBeGreaterThan(-1);
    expect(out.slice(shown)).toContain('✔');
    expect(out.endsWith('No\u001B[0m\n') || out.endsWith('No\n')).toBe(true);
  });

  it('stops when the input ends instead of waiting forever', async () => {
    const { prompter, input } = terminal();
    const answer = expect(prompter.select('Provider?', ['a', 'b'])).rejects.toBeInstanceOf(PromptAborted);
    await tick();
    input.end();
    await answer;
    expect(input.isRaw).toBe(false);
  });

  it('asks for a typed answer when there is no terminal', async () => {
    const { prompter, press } = terminal(false);
    const answer = prompter.select('Provider?', ['none', 'claude']);
    await tick();
    await press('2\n');
    expect(await answer).toBe(1);
  });

  it('cuts a choice line to the terminal width, counting wide characters as two columns', () => {
    expect(fitColumns('abcdef', 10)).toBe('abcdef');
    expect(fitColumns('abcdefghijkl', 10)).toBe('abcdefghi…');
    expect(fitColumns('日本語のプロジェクト', 10)).toBe('日本語の…');
    expect(fitColumns('ab😀😀', 5)).toBe('ab…');
  });

  it('stops on Ctrl+C', async () => {
    const { prompter, press } = terminal();
    const answer = expect(prompter.confirm('Go on?')).rejects.toBeInstanceOf(PromptAborted);
    await tick();
    await press('\u0003');
    await answer;
  });
});
