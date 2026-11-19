import { expect, it } from 'vitest';
import { allowRequest, passes, uploadRejected } from '../src/grading.js';

it('passes high scores', () => {
  expect(passes(80)).toBe(true);
});

it('allows few requests', () => {
  expect(allowRequest(3)).toBe(true);
});

it('rejects large uploads', () => {
  expect(uploadRejected(500)).toBe(true);
});
