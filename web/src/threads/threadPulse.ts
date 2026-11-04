import type { Pulse, PulseCount } from "../social_generated";

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function count(value: unknown): PulseCount | null {
  if (!object(value)) return null;
  const integer = (field: string) => {
    const n = value[field];
    return n === undefined
      ? 0
      : typeof n === "number" && Number.isSafeInteger(n) && n >= 0
        ? n
        : null;
  };
  const needs_you = integer("needs_you"),
    waiting = integer("waiting"),
    unread = integer("unread");
  if (
    needs_you === null ||
    waiting === null ||
    unread === null ||
    needs_you < Math.max(waiting, unread) ||
    needs_you > waiting + unread
  )
    return null;
  return { needs_you, waiting, unread };
}
/** A malformed badge poll is a failed refresh, never an authoritative zero or a navigation failure. */
export function threadPulse(value: unknown): Pulse | null {
  if (!object(value) || typeof value.watermark !== "string") return null;
  const trades = count(value.trades),
    loans = count(value.loans);
  return trades && loans ? { trades, loans, watermark: value.watermark } : null;
}
