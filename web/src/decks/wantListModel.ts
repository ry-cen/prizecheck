import { variantLabel } from "../ui/variantLabel";
import type { WantListLine } from "../want_list_generated";

/** The Decks page's two views (decklist import #209): My Decks at /decks, the Want List at /decks/want-list. */
export type DecksView = "decks" | "want-list";

/** The address segment of the Want List view, under /decks. No Deck id can take it: Deck ids are UUIDs. */
export const WANT_LIST_SEGMENT = "want-list";

/** The Want List's address: All Decks, or scoped to one Deck with `?deck=<id>`. */
export function wantListPath(deckId: string | null = null): string {
  return deckId
    ? `/decks/${WANT_LIST_SEGMENT}?deck=${encodeURIComponent(deckId)}`
    : `/decks/${WANT_LIST_SEGMENT}`;
}

/** The Deck the address scopes the Want List to, or null for All Decks. */
export function scopeInAddress(): string | null {
  return new URLSearchParams(window.location.search).get("deck") || null;
}

/** "1 card", "3 cards". */
export function cards(count: number | string): string {
  const n = Number(count);
  return `${n} ${n === 1 ? "card" : "cards"}`;
}

/** A Card Edition as the deck builder names it: set, collector number and variant. */
export function editionText(edition: {
  set_name: string;
  collector_number: string;
  descriptor: Record<string, unknown>;
}): string {
  return `${edition.set_name} · ${edition.collector_number} · ${variantLabel(edition.descriptor)}`;
}

/**
 * Where a line's counted copies are (spec "The Want List page"): "Have 1 in this Deck · 1 spare", plus "1 in Gardevoir
 * ex" for each other Deck whose copies it counts under One Deck at a time. A line with nothing counted says why: the
 * copies the collector owns are counted for other Decks, or none are owned.
 */
export function countedText(
  line: WantListLine,
  deckName: (deckId: string) => string
): string {
  const parts: string[] = [];
  if (line.held !== "0") parts.push(`${line.held} in this Deck`);
  if (line.spare !== "0") parts.push(`${line.spare} spare`);
  for (const source of line.counted_from)
    parts.push(`${source.quantity} in ${deckName(source.deck_id)}`);
  if (parts.length > 0) return `Have ${parts.join(" · ")}`;
  if (line.owned === "0") return "None owned";
  return line.owned === "1"
    ? "Your 1 is counted for another Deck"
    : `Your ${line.owned} are counted for other Decks`;
}
