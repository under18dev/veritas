/** 1 when a^3 + b^3 + c^3 equals 33, otherwise 0. */
export function sumsTo33(a: number, b: number, c: number): number {
  return a * a * a + b * b * b + c * c * c === 33 ? 1 : 0;
}
