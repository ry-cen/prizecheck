import { useEffect, useRef, useState } from "react";
import { useLoansChanged, usePulseChanged } from "../inbox/Inbox";
import { getPendingLoans } from "../social_generated";
import type { WantList } from "../want_list_generated";
import {
  createPendingReader,
  type PendingReader,
  type PendingState,
} from "./pendingLoans";

export type PendingApi = { state: PendingState; retry: () => void };

/**
 * What the Deck in scope is waiting on from Friends (`createPendingReader`), read apart from the Want List so a refresh
 * never reads the Want List, its cost or prices again. It reads on a new Deck, on new `pins` for it (the revisions of
 * the Want List answer the caller already holds, so an edited Deck List reads again with no extra Want List read), on
 * each return to the window or page after a blur or hide (once for its focus and visibility), when the inbox pulse moves, when Loans change outside the Loans tab (a Friend command, or a
 * request this tab sent), and on Retry. `deckId` null (All Decks) reads nothing. The reader is the instance's: the
 * shell unmounts on sign-out, which drops any answer still in flight, so nothing reaches the next account.
 *
 * It isn't live: a change that moves neither the pulse nor this tab (a Friend's write-off, or the collector's own
 * step on another device) shows at the next focus, visibility change or visit.
 */
export function usePendingLoans(
  deckId: string | null,
  pins: string
): PendingApi {
  const [state, setState] = useState<PendingState>({ kind: "idle" });
  const reader = useRef<PendingReader | null>(null);
  const pulse = usePulseChanged();
  const loans = useLoansChanged();

  useEffect(() => {
    const created = createPendingReader({
      read: getPendingLoans,
      visible: () => document.visibilityState === "visible",
      onState: setState,
    });
    reader.current = created;
    const onReturn = () => created.trigger("return");
    const onLeave = () => created.leave();
    const onVisibility = () => {
      if (document.visibilityState === "visible") created.trigger("return");
      else created.leave();
    };
    window.addEventListener("focus", onReturn);
    window.addEventListener("blur", onLeave);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onReturn);
      window.removeEventListener("blur", onLeave);
      document.removeEventListener("visibilitychange", onVisibility);
      created.dispose();
      reader.current = null;
    };
  }, []);

  useEffect(() => {
    reader.current?.setScope(deckId, pins);
  }, [deckId, pins]);

  // The counters start where the shell left them; only a move after mount asks for a read.
  const seen = useRef({ pulse, loans });
  useEffect(() => {
    if (seen.current.pulse === pulse && seen.current.loans === loans) return;
    seen.current = { pulse, loans };
    reader.current?.trigger("signal");
  }, [pulse, loans]);

  return { state, retry: () => reader.current?.trigger("retry") };
}

/** The pins of a Want List answer as one value, for `usePendingLoans`: they move when the Holdings, the counting
 * setting or any Deck List does. */
export function wantListPins(list: WantList): string {
  return `${list.owner_revision}:${list.settings_revision}:${list.deck_lists_digest}`;
}
