import { it } from 'node:test';
import assert from 'node:assert/strict';
import { isWrapped } from '../src/pricing.ts';

it('wraps a large order', () => {
  assert.equal(isWrapped(8000), true);
});

it('does not wrap a small order', () => {
  assert.equal(isWrapped(100), false);
});
