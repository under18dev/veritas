import { discountAmount, shippingFee } from './pricing.ts';

/** What a customer pays for an order total: the total less the discount, plus shipping. */
export function amountDue(total: number): number {
  return total - discountAmount(total) + shippingFee(total);
}

/** Records an order with `log` and returns what is due. */
export function checkout(total: number, log: (line: string) => void): number {
  const due = amountDue(total);
  log(`order ${total}: due ${due}`);
  return due;
}
