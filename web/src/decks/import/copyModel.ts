/**
 * Copy to my Decks (decklist import #216): the import page's address for a Published Deck, and what a failed copy review
 * says. The review route reads the Published Deck's snapshot itself (POST /api/decks/import/review with the token as
 * its source); nothing here reads it.
 */

/** The import page copying the Published Deck `token`: /decks/import?publication=<token>. */
export const copyPath = (token: string) =>
  `/decks/import?publication=${encodeURIComponent(token)}`;

/** The Published Deck the address asks to copy, or null for a pasted list. */
export function publicationInAddress(): string | null {
  return new URLSearchParams(window.location.search).get("publication") || null;
}

/** What the collector reads when a copy review fails, or null for the errors every review shares. */
export function copyErrorText(code: string): string | null {
  if (code === "PUBLISHED_DECK_NOT_FOUND")
    return "This Published Deck is no longer published, so it can't be copied.";
  if (code === "PUBLISHED_DECK_CHANGED")
    return "This Published Deck was just updated. Reading its new list…";
  if (code === "PUBLIC_PROJECTION_UNAVAILABLE")
    return "The Published Deck couldn't be read just now. Try again.";
  return null;
}

/** A revoked or unknown Published Deck: there is nothing to retry. */
export const copyGone = (code: string) => code === "PUBLISHED_DECK_NOT_FOUND";
