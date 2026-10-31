import { OWNED_CARDS_KEY, parseOwnedCards } from "../decks/import/ownedCards";
import type { FriendCopy, Printings } from "../social_generated";
import { variantLabel } from "../ui/variantLabel";

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
 * Collection and catalog-popup matching: the device's owned-cards choice from Decklist
 * Import (Exact printings, or Use cards I own, the default). Want List chips use each card's Will accept instead.
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

/** What a Friend could lend of one Card Edition: "2 spare · 1 in a Deck", spare copies first. */
export function lendableText(copy: { spare: string; in_deck: string }): string {
  const parts: string[] = [];
  if (copy.spare !== "0") parts.push(`${copy.spare} spare`);
  if (copy.in_deck !== "0") parts.push(`${copy.in_deck} in a Deck`);
  return parts.join(" · ");
}

/**
 * Which Edition a Friend's copy is, when it isn't the card asked about: the set and number of another Printing
 * ("PAL 254"), or the Variant of another Edition of the same Printing ("Reverse Holo"). Null for
 * the very Edition asked about (`wanted`).
 */
export function otherEditionText(
  copy: FriendCopy,
  wanted: string | null
): string | null {
  if (copy.other_printing) return `${copy.set_code} ${copy.collector_number}`;
  if (wanted !== null && copy.edition_id !== wanted)
    return variantLabel(copy.descriptor);
  return null;
}

/** A Friend chip on a Want List line (#251): "Misty W. · 2 spare · 1 in a Deck", then the Edition when it differs. */
export function chipText(copy: FriendCopy, wanted: string): string {
  const other = otherEditionText(copy, wanted);
  return [copy.display_name, lendableText(copy), ...(other ? [other] : [])]
    .filter(Boolean)
    .join(" · ");
}
