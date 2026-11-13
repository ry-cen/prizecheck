import type { DeckLine } from "./deckListModel";

/**
 * Where a Deck's listed copies are, in the four parts the deck builder's copies are drawn in: in this Deck, owned
 * elsewhere (Gather can bring them), lent out to a Friend, and not owned. `inDeck + elsewhere + lent + notOwned ==
 * total` for every Deck List. These are the Deck read's ownership states (`deck_ownership`), which reserve nothing: a
 * copy owned elsewhere may be one another Deck lists too, so it is never "available".
 */
export type DeckReadiness = {
  total: bigint;
  inDeck: bigint;
  elsewhere: bigint;
  lent: bigint;
  notOwned: bigint;
};

/** The four parts over every line, as `deckLine` fits them to each line's quantity. */
export function deckReadiness(lines: readonly DeckLine[]): DeckReadiness {
  const parts: DeckReadiness = {
    total: 0n,
    inDeck: 0n,
    elsewhere: 0n,
    lent: 0n,
    notOwned: 0n,
  };
  for (const line of lines) {
    // `deckLine` fits `elsewhere` and `missing` to the line's need beyond this Deck; the first `lent` missing copies
    // are with a Friend.
    parts.total += line.quantity;
    parts.inDeck += line.quantity - line.elsewhere - line.missing;
    parts.elsewhere += line.elsewhere;
    parts.lent += line.lent;
    parts.notOwned += line.missing - line.lent;
  }
  return parts;
}

/** Explain only the extra copies to acquire; the Deck read already applies promises and counting rules. */
export function missingCountNote(
  notOwned: bigint,
  toGet: string | undefined
): string | null {
  if (toGet === undefined) return null;
  const extra = BigInt(toGet) - notOwned;
  if (extra <= 0n) return null;
  return extra === 1n
    ? "Ways to get missing cards counts 1 more copy: a copy you own is promised in a Trade or Loan, or counted for another Deck."
    : `Ways to get missing cards counts ${extra} more copies: some copies you own are promised in a Trade or Loan, or counted for another Deck.`;
}
