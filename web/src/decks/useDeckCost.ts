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
 */
export function useDeckCost(
  deckId: string,
  deckListRevision: number | null,
  ownerRevision: number | null,
  onNewerRevision: () => void
): DeckCostSettled {
  const [settled, setSettled] = useState<DeckCostSettled>(null);
  const latest = useRef({ deckList: deckListRevision, owner: ownerRevision });

  useEffect(() => {
    latest.current = { deckList: deckListRevision, owner: ownerRevision };
    setSettled(null);
    if (deckListRevision === null || ownerRevision === null) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
    let live = true;
    getDeckCost(deckId, controller.signal)
      .then((cost) => {
        if (!live) return;
        const owner = cost.owner_revision ?? null;
        const deckList = cost.deck_list_revision ?? null;
        const ownerMatches = owner === null || owner === ownerRevision;
        const listMatches = deckList === null || deckList === deckListRevision;
        if (ownerMatches && listMatches) setSettled({ kind: "cost", cost });
        else if (
          (owner !== null && owner > (latest.current.owner ?? 0)) ||
          (deckList !== null && deckList > (latest.current.deckList ?? 0))
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
  }, [deckId, deckListRevision, ownerRevision]);

  return settled;
}
