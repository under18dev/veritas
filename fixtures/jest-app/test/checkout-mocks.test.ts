import { jest } from '@jest/globals';
import { checkout } from '../src/checkout.js';

describe('checkout', () => {
  it('logs the order', () => {
    const log = jest.fn();
    checkout(100, log);
    expect(log).toHaveBeenCalledWith('order 100: due 600');
  });

  it('returns what is due on a large order', () => {
    const log = jest.fn<(line: string) => void>();
    expect(checkout(6000, log)).toBe(5900);
  });
});
