import { useEffect, useRef, useState } from "react";
import { useLoansChanged, usePulseChanged } from "../inbox/Inbox";
import {
  getPendingLoans,
  getWantListMatches,
  type PendingLoans,
  type WantListMatches,
} from "../social_generated";
import type { WantList } from "../want_list_generated";
import type { FriendMatches } from "../social/useFriendMatches";
import type { PendingApi } from "./usePendingLoans";
import { wantListPins } from "./usePendingLoans";

/** Availability is bracketed by pending reads: a partial accept cannot mix old availability with new coverage. */
export async function readBorrowMatches(
  deck: string | null,
  signal: AbortSignal
) {
  if (!deck)
    return { matches: await getWantListMatches({}, signal), pending: null };
  let before = await getPendingLoans(deck, signal);
  for (let attempt = 0; attempt < 3; attempt++) {
    const matches = await getWantListMatches({ deck }, signal);
    const pending = await getPendingLoans(deck, signal);
    if (JSON.stringify(before) === JSON.stringify(pending))
      return { matches, pending };
    before = pending;
  }
  throw new Error("Loan quantities changed during the read");
}

type Snapshot = {
  key: string;
  scope: string | null;
  matches: WantListMatches;
  pending: PendingLoans | null;
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
  const retry = () => setAttempt((n) => n + 1);
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
      ({ matches, pending }) => {
        if (!controller.signal.aborted) {
          setAnswer({ key, scope: deck, matches, pending });
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
  const friends: FriendMatches = !visible
    ? { kind: "none" }
    : {
        kind: "ready",
        hasFriends: visible.matches.has_friends,
        pending: !current,
        byCard: new Map(
          visible.matches.cards.map((card) => [card.edition_id, card.copies])
        ),
      };
  const pending: PendingApi = {
    retry,
    state: !deck
      ? { kind: "idle" }
      : complete?.pending
        ? {
            kind: "ready",
            deckId: deck,
            lines: new Map(
              complete.pending.lines.map((line) => [line.edition_id, line])
            ),
            stale: false,
          }
        : failed === key
          ? visible?.pending
            ? {
                kind: "ready",
                deckId: deck,
                lines: new Map(
                  visible.pending.lines.map((line) => [line.edition_id, line])
                ),
                stale: true,
              }
            : { kind: "failed", deckId: deck }
          : { kind: "loading", deckId: deck },
  };
  return { friends, pending };
}
