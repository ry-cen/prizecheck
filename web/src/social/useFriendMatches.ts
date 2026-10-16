import { useEffect, useMemo, useState } from "react";
import {
  getWantListMatches,
  type FriendCopy,
  type WantListMatches,
} from "../social_generated";
import type { WantList } from "../want_list_generated";
import { readPrintings } from "./friendCards";

/** Friends' cards for the Want List on the page: Friends' copies by the Edition of the card they match. */
export type FriendMatches =
  | { kind: "none" }
  | { kind: "ready"; hasFriends: boolean; byCard: Map<string, FriendCopy[]> };

const NONE: FriendMatches = { kind: "none" };

/**
 * Friends' cards for the Want List answer on the page (#251): GET /api/social/want-list-matches for the same scope,
 * read after the Want List and apart from it, so its revisions, its cost and its export never wait on Friends. It reads
 * again when the answer changes (another scope, or a Deck List, Holding or setting change). While it loads, and when it
 * fails, there are no Friends' cards: the page is the Want List without them.
 */
export function useFriendMatches(list: WantList | null): FriendMatches {
  const [state, setState] = useState<{
    key: string;
    answer: WantListMatches;
  } | null>(null);
  const printings = useMemo(readPrintings, []);
  const key = list
    ? [
        list.deck_id ?? "",
        list.settings_revision,
        list.owner_revision,
        list.deck_lists_digest,
      ].join(":")
    : "";

  useEffect(() => {
    if (!list) return;
    const controller = new AbortController();
    getWantListMatches(
      { deck: list.deck_id, printings },
      controller.signal
    ).then(
      (answer) => setState({ key, answer }),
      () => {
        if (!controller.signal.aborted) setState(null);
      }
    );
    return () => controller.abort();
  }, [key]);

  const scope = list?.deck_id ?? "";
  return useMemo(() => {
    // The last answer stays up while the next one loads, but one for another scope is never shown against this one.
    if (!state || key === "" || state.key.split(":")[0] !== scope) return NONE;
    return {
      kind: "ready",
      hasFriends: state.answer.has_friends,
      byCard: new Map(
        state.answer.cards.map((card) => [card.edition_id, card.copies])
      ),
    };
  }, [state, scope, key]);
}
