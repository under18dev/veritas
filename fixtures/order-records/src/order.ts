export interface Order {
  total: number;
  vip: boolean;
}

/** Flat discount for an order. */
export function orderDiscount(order: Order): number {
  if (order.total > 1000) {
    return 100;
  }
  return 0;
}

/** Shipping fee for the items in a cart (prices of each item). */
export function shippingFee(items: readonly number[]): number {
  return items.length >= 3 ? 0 : 500;
}
