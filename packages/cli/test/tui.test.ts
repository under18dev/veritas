import { describe, expect, it } from 'vitest';
import { shouldLaunchTui } from '../src/tui.js';

const tty = { isTTY: true };
const pipe = { isTTY: false };
const bare = ['node', 'veritas'];

describe('shouldLaunchTui', () => {
  it('opens the TUI only without arguments, on a terminal and outside CI', () => {
    expect(shouldLaunchTui(bare, tty, tty, {})).toBe(true);
    expect(shouldLaunchTui(bare, tty, tty, { CI: 'false' })).toBe(true);
  });

  it('keeps printing help when anything else is the case', () => {
    expect(shouldLaunchTui([...bare, '--json'], tty, tty, {})).toBe(false);
    expect(shouldLaunchTui([...bare, 'run'], tty, tty, {})).toBe(false);
    expect(shouldLaunchTui([...bare, '-C', '.'], tty, tty, {})).toBe(false);
    expect(shouldLaunchTui(bare, pipe, tty, {})).toBe(false);
    expect(shouldLaunchTui(bare, tty, pipe, {})).toBe(false);
    expect(shouldLaunchTui(bare, {}, tty, {})).toBe(false);
    expect(shouldLaunchTui(bare, tty, tty, { CI: 'true' })).toBe(false);
    expect(shouldLaunchTui(bare, tty, tty, { CI: '1' })).toBe(false);
  });
});
