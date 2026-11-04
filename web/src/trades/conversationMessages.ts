// Shared collector availability and completed Trade copy.
export const RETRY = "Retry";
export const UNAVAILABLE_NOTE = "This collector is no longer available";
export const SUSPENDED_NOTE = "Your account can't trade or message right now.";
export const NEW_TO_TRADING = "New to trading";
/** A private or unavailable count is omitted. */
export function trackRecord(n: number | null | undefined): string | null {
  if (n === null || n === undefined) return null;
  if (n === 0) return NEW_TO_TRADING;
  return n === 1 ? "1 completed trade" : `${n} completed trades`;
}
