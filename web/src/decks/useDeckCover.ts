import { useRef, useState } from "react";
import { DeckError, setDeckCover } from "../decks_generated";

/**
 * Set as cover (#291) in a copy's sheet: sets the Deck's cover card, or clears it when the card already is the
 * cover. The command is checked against the cover the page last read, so a cover changed elsewhere re-reads the
 * Deck and says so. A retry after a failed request reuses its key.
 */
export function useDeckCover(options: {
  deckId: string;
  /** detail.cover_edition_id ?? null */
  coverId: string | null;
  beginCommand: () => () => void;
  onCover: (editionId: string | null) => void;
  reread: () => Promise<unknown>;
  onMissing: () => void;
}): {
  busy: boolean;
  messageFor: (editionId: string) => string;
  toggle: (editionId: string) => Promise<void>;
  reset: () => void;
} {
  const { deckId, coverId, beginCommand, onCover, reread, onMissing } = options;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    editionId: string;
    text: string;
  } | null>(null);
  const failed = useRef<{
    target: string | null;
    expected: string | null;
    key: string;
  } | null>(null);

  async function toggle(editionId: string) {
    if (busy) return;
    const target = coverId === editionId ? null : editionId;
    const expected = coverId;
    const retry = failed.current;
    const key =
      retry && retry.target === target && retry.expected === expected
        ? retry.key
        : crypto.randomUUID();
    failed.current = null;
    setBusy(true);
    setMessage(null);
    const settle = beginCommand();
    try {
      const result = await setDeckCover(deckId, {
        edition_id: target,
        expected_edition_id: expected,
        idempotency_key: key,
      });
      onCover(result.cover_edition_id);
      setMessage({
        editionId,
        text: target
          ? "This card is now the Deck's cover."
          : "This card is no longer the Deck's cover.",
      });
      settle();
    } catch (cause) {
      if (cause instanceof DeckError && cause.status === 409) {
        await reread();
        setMessage({
          editionId,
          text:
            cause.code === "COVER_NOT_ON_DECK_LIST"
              ? "This card is no longer on the Deck List, so it can't be the cover."
              : "This Deck's cover changed somewhere else, so nothing changed. It's up to date now: try again.",
        });
      } else if (cause instanceof DeckError && cause.status === 404) {
        onMissing();
      } else {
        failed.current = { target, expected, key };
        setMessage({
          editionId,
          text: "The cover couldn't be changed. Check your connection and try again.",
        });
        settle();
      }
    } finally {
      setBusy(false);
    }
  }

  return {
    busy,
    messageFor: (editionId) =>
      message && message.editionId === editionId ? message.text : "",
    toggle,
    reset: () => setMessage(null),
  };
}
