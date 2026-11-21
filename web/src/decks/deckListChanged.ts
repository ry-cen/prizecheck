import { useEffect, useRef } from "react";
import type { GameId } from "../gameScope";

/**
 * Tells a Deck's open builder that its Deck List changed somewhere it can't see (#215): Replace list…'s Undo runs from a
 * toast that outlives the import page, after the builder has already read the replaced list. The builder reads again.
 */
const EVENT = "prizecheck:deck-list-changed";

type Detail = { game: GameId; deckId: string };

/** A bare string detail comes from before games were named and means a Pokémon Deck. */
const detailOf = (value: unknown): Detail | null => {
  if (typeof value === "string") return { game: "pokemon", deckId: value };
  const detail = value as Partial<Detail> | null;
  return detail && typeof detail.deckId === "string"
    ? { game: detail.game ?? "pokemon", deckId: detail.deckId }
    : null;
};

export function announceDeckListChanged(
  deckId: string,
  game: GameId = "pokemon"
) {
  window.dispatchEvent(
    new CustomEvent<Detail>(EVENT, { detail: { game, deckId } })
  );
}

/** Calls `onChange` whenever `announceDeckListChanged` names this Deck of this game, while the caller is mounted. */
export function useDeckListChanged(
  deckId: string,
  onChange: () => void,
  game: GameId = "pokemon"
) {
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = detailOf((event as CustomEvent<unknown>).detail);
      if (detail?.deckId === deckId && detail.game === game) latest.current();
    };
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
  }, [deckId, game]);
}
