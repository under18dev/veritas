/** Whether a request with the given per-minute count is allowed. */
export function isAllowed(requestsThisMinute: number): boolean {
  return requestsThisMinute <= 100;
}
