import { useEffect, useRef, useState } from "react";
import {
  DeckError,
  reviewImport,
  type ImportFix,
  type ImportReview,
} from "../../decks_generated";
import {
  characters,
  MAX_PASTE_CHARACTERS,
  reviewErrorText,
} from "./importModel";
import type { OwnedCards } from "./ownedCards";

export type ImportReviewState = {
  /** The newest answer for this paste, or null before the first (and while the paste is empty or too long). */
  review: ImportReview | null;
  /** True when `review` answers exactly the current text, setting and fixes, so saving it saves what is shown. */
  current: boolean;
  /** A request for the current text, setting and fixes is on its way. */
  pending: boolean;
  /** Why the last request failed, in the collector's words; "" when it didn't. */
  error: string;
  /** The failed request's API error code (DeckError.code), or "" when none. */
  code: string;
  /** Posts the current text, setting and fixes again: Retry, or after saving found the catalog changed. */
  retry: () => void;
};

type Answer = {
  review: ImportReview | null;
  key: string;
  pending: boolean;
  error: string;
  code: string;
};

/**
 * Posts the paste to the review route (POST /api/decks/import/review, read-only) whenever the text, the owned-cards
 * setting (#214) or the fixes change, after `delay` ms without another change: the paste screen passes 300 so its
 * live count follows typing, the review passes 0 so a fix shows at once. Only the newest request's answer is kept. An
 * empty paste posts nothing, and one over 20,000 characters posts nothing and reads as IMPORT_TOO_LONG, as the API
 * would answer. `deckId` is the Deck Replace list… replaces (#215), or null for a new Deck.
 */
export function useImportReview(
  text: string,
  fixes: ImportFix[],
  owned: OwnedCards,
  delay: number,
  deckId: string | null = null
): ImportReviewState {
  const fixesKey = JSON.stringify(fixes);
  const key = `${text}\u0000${owned}\u0000${fixesKey}\u0000${deckId ?? ""}`;
  const [answer, setAnswer] = useState<Answer>({
    review: null,
    key: "",
    pending: false,
    error: "",
    code: "",
  });
  const [attempt, setAttempt] = useState(0);
  const ticket = useRef(0);

  useEffect(() => {
    const mine = ++ticket.current;
    if (!text.trim()) {
      setAnswer({ review: null, key, pending: false, error: "", code: "" });
      return;
    }
    if (characters(text) > MAX_PASTE_CHARACTERS) {
      setAnswer({
        review: null,
        key,
        pending: false,
        error: reviewErrorText(422, "IMPORT_TOO_LONG"),
        code: "IMPORT_TOO_LONG",
      });
      return;
    }
    setAnswer((previous) => ({ ...previous, pending: true }));
    const timer = setTimeout(() => {
      reviewImport({
        source: { text },
        owned,
        fixes: JSON.parse(fixesKey) as ImportFix[],
        ...(deckId ? { deck_id: deckId } : {}),
      })
        .then((review) => {
          if (mine === ticket.current)
            setAnswer({ review, key, pending: false, error: "", code: "" });
        })
        .catch((cause: unknown) => {
          if (mine !== ticket.current) return;
          const status = cause instanceof DeckError ? cause.status : 0;
          const code = cause instanceof DeckError ? cause.code : "";
          setAnswer((previous) => ({
            ...previous,
            pending: false,
            error: reviewErrorText(status, code),
            code,
          }));
        });
    }, delay);
    return () => clearTimeout(timer);
    // `key` is text, owned, fixesKey and deckId together; `attempt` posts the same request again.
  }, [text, owned, fixesKey, delay, attempt, deckId]);

  return {
    review: answer.review,
    current: answer.review !== null && answer.key === key && !answer.pending,
    pending: answer.pending,
    error: answer.error,
    code: answer.code,
    retry: () => setAttempt((count) => count + 1),
  };
}
