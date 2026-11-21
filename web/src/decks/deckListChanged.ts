import { useEffect, useRef } from "react";
import { useFixedGame, type GameId } from "../gameScope";

/**
 * Tells a Deck's open builder that its Deck List changed somewhere it can't see (#215): Replace list…'s Undo runs from a
 * toast that outlives the import page, after the builder has already read the replaced list. The builder reads again.
 */

/** Pokémon keeps the original event name; another game has its own, so neither ever hears the other. */
export const deckListChangedEvent = (game: GameId = "pokemon") =>
  game === "pokemon"
    ? "prizecheck:deck-list-changed"
    : `prizecheck:${game}:deck-list-changed`;

export function announceDeckListChanged(
  deckId: string,
  game: GameId = "pokemon"
) {
  window.dispatchEvent(
    new CustomEvent<string>(deckListChangedEvent(game), { detail: deckId })
  );
}

/** Calls `onChange` whenever `announceDeckListChanged` names this Deck, while the caller is mounted. `game` is fixed
 * for this instance (see `useFixedGame`). */
export function useDeckListChanged(
  deckId: string,
  onChange: () => void,
  game: GameId = "pokemon"
) {
  useFixedGame(game, "useDeckListChanged");
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    const name = deckListChangedEvent(game);
    const listener = (event: Event) => {
      if ((event as CustomEvent<string>).detail === deckId) latest.current();
    };
    window.addEventListener(name, listener);
    return () => window.removeEventListener(name, listener);
  }, [deckId]);
}
