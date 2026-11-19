import { expect, it } from 'vitest';
import { isAllowed } from '../src/limit.js';

it('allows the 100th request', () => {
  expect(isAllowed(100)).toBe(true);
});

it('rejects the 101st request', () => {
  expect(isAllowed(101)).toBe(false);
});
