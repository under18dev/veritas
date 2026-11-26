import { describe, it } from 'node:test';
import { strictEqual } from 'node:assert/strict';
import { shippingFee } from '../src/pricing.ts';

describe('shippingFee', () => {
  describe('at the free shipping threshold', () => {
    it('charges shipping just below the threshold', () => {
      strictEqual(shippingFee(4999), 500);
    });

    it('ships free exactly at the threshold', () => {
      strictEqual(shippingFee(5000), 0);
    });
  });

  it('is checked on both sides in subtests', async (t) => {
    await t.test('a small order', () => {
      t.assert.equal(shippingFee(10), 500);
    });
    await t.test('a large order', () => {
      t.assert.equal(shippingFee(9000), 0);
    });
  });

  it.skip('is skipped', () => {
    strictEqual(shippingFee(1), 500);
  });

  it('is not written yet', { todo: 'cover refunds' });
});
