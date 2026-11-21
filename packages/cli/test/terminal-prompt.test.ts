import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { PromptAborted, terminalPrompter } from '../src/commands/terminal-prompt.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

/** A fake terminal: keys go in through `input`, the drawing comes out of `output`. */
function terminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: () => input });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  output.resume();
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

  return { prompter, press };
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

  it('stops on Ctrl+C', async () => {
    const { prompter, press } = terminal();
    const answer = expect(prompter.confirm('Go on?')).rejects.toBeInstanceOf(PromptAborted);
    await tick();
    await press('\u0003');
    await answer;
  });
});
