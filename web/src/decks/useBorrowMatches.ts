import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLoansChanged, usePulseChanged } from "../inbox/Inbox";
import {
  getPendingLoans,
  getWaitingLoans,
  getWantListMatches,
  type FriendCopy,
  type PendingLoans,
  type WaitingLoans,
  type WantListMatches,
} from "../social_generated";
import type { WantList } from "../want_list_generated";
import { useBorrowReadiness } from "../loans/BorrowDrafts";
import type { PendingLine } from "../social_generated";
import { waitingByDeck, type PendingState } from "./pendingLoans";

export type FriendMatches =
  | { kind: "none" }
  | {
      kind: "ready";
      hasFriends: boolean;
      pending: boolean;
      byCard: Map<string, FriendCopy[]>;
    };
export type PendingApi = {
  /** The scoped Deck's own read; idle on All Decks. */
  state: PendingState;
  /** What one Deck is waiting on: on a Deck's scope, `state` for that Deck and idle for any other; on All Decks, that
   * Deck's share of the borrower-wide read (GET /api/loans/waiting). */
  forDeck: (deckId: string) => PendingState;
  /** The read this scope uses is in and fresh: borrowing may start from it. */
  ready: boolean;
  /** One notice for the page: the read failed with no answer, or a refresh failed and the last answer is kept. */
  notice: "failed" | "stale" | null;
  retry: () => void;
};

const IDLE: PendingState = { kind: "idle" };
const NO_LINES = new Map<string, PendingLine>();

/** The scoped builder: one Deck's own state, idle for every other Deck. */
export function pendingApi(state: PendingState, retry: () => void): PendingApi {
  return {
    state,
    forDeck: (id) =>
      state.kind !== "idle" && state.deckId === id ? state : IDLE,
    ready: state.kind === "ready" && !state.stale,
    notice:
      state.kind === "failed"
        ? "failed"
        : state.kind === "ready" && state.stale
          ? "stale"
          : null,
    retry,
  };
}

/** Holdings, counting settings and Deck List revisions already read by the Want List. */
function wantListPins(list: WantList): string {
  return `${list.owner_revision}:${list.settings_revision}:${list.deck_lists_digest}`;
}

/** Availability is bracketed by pending reads: a partial accept cannot mix old availability with new coverage. */
export async function readBorrowMatches(
  deck: string | null,
  signal: AbortSignal
) {
  const read = (): Promise<PendingLoans | WaitingLoans> =>
    deck ? getPendingLoans(deck, signal) : getWaitingLoans(signal);
  const answer = (
    matches: WantListMatches,
    found: PendingLoans | WaitingLoans
  ) =>
    deck
      ? { matches, pending: found as PendingLoans, waiting: null }
      : { matches, pending: null, waiting: found as WaitingLoans };
  let before = await read();
  for (let attempt = 0; attempt < 3; attempt++) {
    const matches = await getWantListMatches(deck ? { deck } : {}, signal);
    const found = await read();
    if (JSON.stringify(before) === JSON.stringify(found))
      return answer(matches, found);
    before = found;
  }
  throw new Error("Loan quantities changed during the read");
}

type Snapshot = {
  key: string;
  scope: string | null;
  matches: WantListMatches;
  pending: PendingLoans | null;
  waiting: WaitingLoans | null;
};

/** One refresh generation owns both responses. Old, loading and failed generations never enable borrowing. */
export function useBorrowMatches(
  list: WantList | null,
  refresh: number,
  pins = ""
): { friends: FriendMatches; pending: PendingApi } {
  const pulse = usePulseChanged(),
    loans = useLoansChanged();
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<Snapshot | null>(null);
  const [failed, setFailed] = useState("");
  const away = useRef(false);
  const deck = list?.deck_id ?? null;
  const key = list
    ? `${deck}:${wantListPins(list)}:${refresh}:${pins}:${pulse}:${loans}:${attempt}`
    : "";
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    const leave = () => {
      away.current = true;
    };
    const returned = () => {
      if (away.current && document.visibilityState !== "hidden") {
        away.current = false;
        retry();
      }
    };
    const visibility = () =>
      document.visibilityState === "hidden" ? leave() : returned();
    window.addEventListener("blur", leave);
    window.addEventListener("focus", returned);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("blur", leave);
      window.removeEventListener("focus", returned);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  useEffect(() => {
    if (!key) return;
    if (document.visibilityState === "hidden") {
      away.current = true;
      return;
    }
    const controller = new AbortController();
    readBorrowMatches(deck, controller.signal).then(
      ({ matches, pending, waiting }) => {
        if (!controller.signal.aborted) {
          setAnswer({ key, scope: deck, matches, pending, waiting });
          setFailed("");
        }
      },
      () => {
        if (!controller.signal.aborted) setFailed(key);
      }
    );
    return () => controller.abort();
  }, [key]);
  const complete = answer && answer.key === key ? answer : null;
  const current = complete !== null;
  const visible = answer && answer.scope === deck ? answer : null;
  // Downstream reads key on these maps' identity (Trade for it re-reads when `byCard` changes), so each is rebuilt
  // only when its answer changes, never on a re-render that brings the same one.
  const byCard = useMemo(
    () =>
      new Map(
        visible
          ? visible.matches.cards.map((card) => [card.edition_id, card.copies])
          : []
      ),
    [visible]
  );
  const lines = useMemo(
    () =>
      visible?.pending
        ? new Map(visible.pending.lines.map((line) => [line.edition_id, line]))
        : null,
    [visible]
  );
  const byDeck = useMemo(
    () => (visible?.waiting ? waitingByDeck(visible.waiting.lines) : null),
    [visible]
  );
  // The last answer stays up while another scope's loads, so the Friends view and its switch don't flicker; another
  // scope's cards are never shown against this one, and borrowing waits (`pending`) until this scope's answer is in.
  const hasFriends = answer?.matches.has_friends;
  const friends: FriendMatches = useMemo(
    () =>
      hasFriends === undefined
        ? { kind: "none" }
        : { kind: "ready", hasFriends, pending: !current, byCard },
    [hasFriends, current, byCard]
  );
  useBorrowReadiness(
    deck,
    list ? (failed === key ? "failed" : current) : null,
    retry
  );
  const failedNow = failed === key;
  const pending: PendingApi = useMemo(() => {
    if (deck)
      return pendingApi(
        lines
          ? { kind: "ready", deckId: deck, lines, stale: failedNow }
          : failedNow
            ? { kind: "failed", deckId: deck }
            : { kind: "loading", deckId: deck },
        retry
      );
    return {
      retry,
      state: IDLE,
      forDeck: (id) =>
        byDeck
          ? {
              kind: "ready",
              deckId: id,
              lines: byDeck.get(id) ?? NO_LINES,
              stale: failedNow,
            }
          : failedNow
            ? { kind: "failed", deckId: id }
            : { kind: "loading", deckId: id },
      ready: byDeck !== null && !failedNow,
      notice: byDeck
        ? failedNow
          ? "stale"
          : null
        : failedNow
          ? "failed"
          : null,
    };
  }, [retry, deck, lines, byDeck, failedNow]);
  return { friends, pending };
}
