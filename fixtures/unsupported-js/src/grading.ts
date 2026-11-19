/** Whether a score passes; uses division, which the formal subset does not model. */
export function passes(score: number): boolean {
  return score / 2 >= 25;
}

let requestsSeen = 0;

/** Whether another request is allowed; depends on and changes module state. */
export function allowRequest(perSecond: number): boolean {
  requestsSeen += 1;
  return perSecond <= 10 && requestsSeen > 0;
}

/** Whether an upload is rejected; NaN sizes are treated as too large. */
export function uploadRejected(megabytes: number): boolean {
  if (Number.isNaN(megabytes)) return true;
  return megabytes >= 100;
}
