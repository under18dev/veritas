/** Flat discount applied at checkout. */
export function discountAmount(total: number): number {
  if (total > 1000) {
    return 100;
  }
  return 0;
}

/** Shipping fee for an order total. */
export function shippingFee(total: number): number {
  return total >= 5000 ? 0 : 500;
}

/** Whether an order of this total is wrapped as a gift at no charge. */
export function isWrapped(total: number): boolean {
  return total >= 3000;
}
