import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { checkout } from '../src/checkout.ts';

describe('checkout', () => {
  it('logs the order', () => {
    const log = mock.fn();
    checkout(100, log);
    assert.deepStrictEqual(log.mock.calls[0]?.arguments, ['order 100: due 600']);
  });

  it('returns what is due on a large order', () => {
    assert.strictEqual(checkout(6000, () => {}), 5900);
  });
});
