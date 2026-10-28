import { useEffect, useRef, useState } from "react";
import { getDeckCost, type DeckCost } from "../prices_generated";

// The cost route answers within the gateway's three-second budget; a slower answer becomes "unavailable".
const CLIENT_TIMEOUT_MS = 3_500;

export type DeckCostSettled =
  { kind: "cost"; cost: DeckCost } | { kind: "unavailable" } | null;

/**
 * The Deck's cost (GET /api/decks/{id}/cost), read once per Deck read: the deck builder's header shows its
 * Deck List cost and cost to complete, and Collection's Deck banner (#181) also shows its Holdings cost from the same
 * answer. null while the request is pending.
 *
 * An answer belongs to one inventory revision and one Deck List revision. An answer for the revisions drawn is
 * shown; one naming a newer revision calls `onNewerRevision` (the page reads the Deck again, which asks again);
 * one for an older revision belongs to no live request and ends as "unavailable" instead of waiting.
 *
 * A page that draws the Deck's need (the deck builder's Buy missing) also passes the settings revision it read (#208):
 * the cost to complete follows the Want List counting setting, which moves neither revision above.
 *
 * A Target Format change advances the Deck List revision but not the cards, so the cost it was drawn for still stands.
 * `cardsRevision` is the revision that last changed the cards (`useCardsRevision`): only it, the Deck and the other
 * revisions start a new access, while an answer is still checked against the current `deckListRevision`.
 */
export function useDeckCost(
  deckId: string,
  deckListRevision: number | null,
  ownerRevision: number | null,
  onNewerRevision: () => void,
  settingsRevision: number | null = null,
  cardsRevision: number | null = deckListRevision
): DeckCostSettled {
  const [settled, setSettled] = useState<DeckCostSettled>(null);
  const latest = useRef({
    deckList: deckListRevision,
    owner: ownerRevision,
    settings: settingsRevision,
  });

  useEffect(() => {
    latest.current = {
      deckList: deckListRevision,
      owner: ownerRevision,
      settings: settingsRevision,
    };
    setSettled(null);
    if (cardsRevision === null || ownerRevision === null) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
    let live = true;
    getDeckCost(deckId, controller.signal)
      .then((cost) => {
        if (!live) return;
        const owner = cost.owner_revision ?? null;
        const deckList = cost.deck_list_revision ?? null;
        const settings = cost.settings_revision ?? null;
        const ownerMatches = owner === null || owner === ownerRevision;
        const listMatches =
          deckList === null || deckList === latest.current.deckList;
        const settingsMatch =
          settingsRevision === null ||
          settings === null ||
          settings === settingsRevision;
        if (ownerMatches && listMatches && settingsMatch)
          setSettled({ kind: "cost", cost });
        else if (
          (owner !== null && owner > (latest.current.owner ?? 0)) ||
          (deckList !== null && deckList > (latest.current.deckList ?? 0)) ||
          (settingsRevision !== null &&
            settings !== null &&
            settings > (latest.current.settings ?? 0))
        )
          onNewerRevision();
        else setSettled({ kind: "unavailable" });
      })
      .catch(() => {
        if (live) setSettled({ kind: "unavailable" });
      })
      .finally(() => clearTimeout(timer));
    return () => {
      live = false;
      clearTimeout(timer);
      controller.abort();
    };
    // onNewerRevision is a fresh closure on every render; only the Deck and its revisions start a new access.
  }, [deckId, cardsRevision, ownerRevision, settingsRevision]);

  return settled;
}

/**
 * The Deck List revision that last changed the cards: `revision` follows the Deck List, except a revision named by
 * `formatOnly` (the one a Target Format change produced), which leaves it where it was.
 */
export function useCardsRevision(
  revision: number | null,
  formatOnly: number | null
): number | null {
  const cards = useRef<number | null>(null);
  if (revision === null) cards.current = null;
  else if (
    cards.current === null ||
    (revision !== cards.current && revision !== formatOnly)
  )
    cards.current = revision;
  return cards.current;
}
