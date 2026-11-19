/** Positive part of x. */
export function relu(x: number): number {
  return x > 0 ? x : 0;
}

/** Smallest of a and b, using a library call outside the formal subset. */
export function smaller(a: number, b: number): number {
  return Math.min(a, b);
}
