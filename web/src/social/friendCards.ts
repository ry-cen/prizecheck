import { OWNED_CARDS_KEY, parseOwnedCards } from "../decks/import/ownedCards";
import type { Printings } from "../social_generated";

/** A Friend's Collection (#250): /friends/<Handle>. The Handle is the one the Friends drawer shows. */
export const FRIENDS_PATH = "/friends";

export function friendCollectionPath(handle: string): string {
  return `${FRIENDS_PATH}/${encodeURIComponent(handle)}`;
}

/** The Handle a Friend's Collection address names, or null for any other address. */
export function friendHandleAt(path: string): string | null {
  const match = /^\/friends\/([^/]+)$/.exec(path);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/**
 * Which of a Friend's copies count for a card the collector needs: the device's owned-cards choice from Decklist
 * Import (Exact printings, or Use cards I own, the default), so Friends' matches follow the same rule as the cards
 * the collector uses from their own Collection.
 */
export function readPrintings(): Printings {
  try {
    return parseOwnedCards(window.localStorage.getItem(OWNED_CARDS_KEY)) ===
      "exact"
      ? "exact"
      : "reprint_group";
  } catch {
    return "reprint_group";
  }
}
