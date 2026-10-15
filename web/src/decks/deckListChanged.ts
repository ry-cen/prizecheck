import { useEffect, useRef } from "react";

/**
 * Tells a Deck's open builder that its Deck List changed somewhere it can't see (#215): Replace list…'s Undo runs from a
 * toast that outlives the import page, after the builder has already read the replaced list. The builder reads again.
 */
const EVENT = "prizecheck:deck-list-changed";

export function announceDeckListChanged(deckId: string) {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: deckId }));
}

/** Calls `onChange` whenever `announceDeckListChanged` names this Deck, while the caller is mounted. */
export function useDeckListChanged(deckId: string, onChange: () => void) {
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    const listener = (event: Event) => {
      if ((event as CustomEvent<string>).detail === deckId) latest.current();
    };
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
  }, [deckId]);
}
