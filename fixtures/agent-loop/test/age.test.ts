import { expect, it } from 'vitest';
import { isSenior } from '../src/age.js';

it('treats an 80 year old as a senior', () => {
  expect(isSenior(80)).toBe(true);
});

it('does not treat a 20 year old as a senior', () => {
  expect(isSenior(20)).toBe(false);
});
