import type { DiscoverCost, DiscoverFormat } from "../discovery_generated";
import { FORMAT_SHORT_NAMES, POKEMON_FORMATS } from "../games/pokemon/formats";

/** The format chips after Any, in the spec's order, and each Target Format's short name on a deck card. */
export const FORMAT_CHIPS: readonly DiscoverFormat[] = POKEMON_FORMATS.map(
  ({ value }) => value
);
export const FORMAT_LABELS: Record<DiscoverFormat, string> = FORMAT_SHORT_NAMES;

export type CostText = {
  /** "$142", "$118+" or "Price on page". */
  text: string;
  /** "3 cards not priced yet" when some copies have no cached quote; the tooltip and the screen reader text. */
  note: string | null;
  /** Price on page is drawn muted. */
  muted: boolean;
};

const WHOLE = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const CENTS = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** An exact decimal amount as a deck cost: whole dollars from $1 up ("$142"), cents below ("$0.65"). */
export function dollars(amount: string): string {
  const value = Number(amount);
  // Cents round first, so "0.995" (a cent short of a dollar) reads "$1", not "$1.00".
  return Math.round(value * 100 + 1e-9) >= 100
    ? WHOLE.format(value)
    : CENTS.format(value);
}

/**
 * A Discover card's cost (spec "Discover"): "$142" when every copy has a cached quote, "$118+" with "N cards not
 * priced yet" when some don't, and "Price on page" (muted) when none do. Stale quotes already count as priced.
 */
export function costText(cost: DiscoverCost): CostText {
  if (cost.amount === null)
    return { text: "Price on page", note: null, muted: true };
  const missing = Number(cost.total_copies) - Number(cost.priced_copies);
  const text = dollars(cost.amount);
  if (missing <= 0) return { text, note: null, muted: false };
  return {
    text: `${text}+`,
    note: `${missing.toLocaleString("en-US")} ${missing === 1 ? "card" : "cards"} not priced yet`,
    muted: false,
  };
}

/** "Oct 11, 2026". */
export function publishedDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
