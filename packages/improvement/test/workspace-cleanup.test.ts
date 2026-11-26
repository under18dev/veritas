import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type LogEvent, withRunContext } from '@under18dev/veritas-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspace, removeWorkspace, removeWorkspaceAfterApply, workspaceBase } from '../src/index.js';
import { project } from './helpers.js';

const state = vi.hoisted(() => ({
  registered: 0,
  unregistered: 0,
  /** Removing anything below this directory fails. */
  failBelow: null as string | null,
}));

vi.mock('@under18dev/veritas-core', async (original) => ({
  ...(await original<typeof import('@under18dev/veritas-core')>()),
  onExitCleanup: () => {
    state.registered += 1;

    return () => {
      state.unregistered += 1;
    };
  },
}));

// Removing the copy fails as it does on Windows when a process the run started still has a file of it open.
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  const rm: typeof actual.rmSync = (target, options) => {
    if (state.failBelow !== null && String(target).startsWith(state.failBelow + path.sep))
      throw Object.assign(new Error(`EBUSY: resource busy or locked, rm '${String(target)}'`), {
        code: 'EBUSY',
      });

    return actual.rmSync(target, options);
  };

  return { ...actual, default: { ...actual, rmSync: rm }, rmSync: rm };
});

let cache: string;

beforeEach(() => {
  // A cache directory of its own, so workspaces of tests running in parallel do not count.
  const parent = path.dirname(path.dirname(workspaceBase()));
  mkdirSync(parent, { recursive: true });
  cache = mkdtempSync(path.join(parent, 'veritas-test-'));
  for (const name of ['XDG_CACHE_HOME', 'LOCALAPPDATA']) vi.stubEnv(name, cache);
});

afterEach(() => {
  state.registered = 0;
  state.unregistered = 0;
  state.failBelow = null;
  vi.unstubAllEnvs();
  rmSync(cache, { recursive: true, force: true });
});

describe('exit cleanup of the isolated copy', () => {
  it('is unregistered once the copy is removed', () => {
    const ws = createWorkspace(project({ 'src/a.ts': 'x' }));

    expect(state).toMatchObject({ registered: 1, unregistered: 0 });
    removeWorkspace(ws);
    expect(state).toMatchObject({ registered: 1, unregistered: 1 });
    expect(existsSync(ws)).toBe(false);
  });

  it('stays registered when removing the copy fails, to try again at exit, and the failure is not hidden', () => {
    const ws = createWorkspace(project({ 'src/a.ts': 'x' }));
    state.failBelow = cache;

    expect(() => removeWorkspace(ws)).toThrow(/EBUSY/);
    expect(state).toMatchObject({ registered: 1, unregistered: 0 });
    // A later removal that succeeds (the one at exit) unregisters it.
    state.failBelow = null;
    removeWorkspace(ws);
    expect(state).toMatchObject({ registered: 1, unregistered: 1 });
    expect(existsSync(ws)).toBe(false);
  });

  it('stays registered when making the copy fails and so does removing it, which keeps the first error', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'veritas-outside-'));
    const root = project({ 'src/a.ts': 'x' });
    symlinkSync(outside, path.join(root, 'test'), process.platform === 'win32' ? 'junction' : 'dir');
    state.failBelow = cache;

    expect(() => createWorkspace(root)).toThrow(/links outside the project/);
    expect(state).toMatchObject({ registered: 1, unregistered: 0 });
  });
});

describe('removing the isolated copy after an apply', () => {
  it('warns instead of throwing when the copy cannot be removed, keeping it registered for exit', async () => {
    const ws = createWorkspace(project({ 'src/a.ts': 'x' }));
    state.failBelow = cache;
    const events: LogEvent[] = [];

    await withRunContext({ sinks: [(event) => events.push(event)] }, async () => {
      expect(() => removeWorkspaceAfterApply(ws)).not.toThrow();
    });
    expect(events.find((event) => event.level === 'warn')?.message).toContain('could not be removed: EBUSY');
    expect(state).toMatchObject({ registered: 1, unregistered: 0 });
  });

  it('keeps the result of an apply whose copy cannot be removed, and its original error', async () => {
    const failing = () => {
      throw new Error('EBUSY');
    };
    const apply = async (outcome: () => string) => {
      try {
        return outcome();
      } finally {
        removeWorkspaceAfterApply('copy', failing);
      }
    };

    await expect(apply(() => 'applied')).resolves.toBe('applied');
    await expect(
      apply(() => {
        throw new Error('the patch failed');
      }),
    ).rejects.toThrow('the patch failed');
  });

  it('removes the copy and unregisters it when it can', () => {
    const ws = createWorkspace(project({ 'src/a.ts': 'x' }));

    removeWorkspaceAfterApply(ws);
    expect(existsSync(ws)).toBe(false);
    expect(state).toMatchObject({ registered: 1, unregistered: 1 });
  });
});
