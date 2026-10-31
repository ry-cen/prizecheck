import { useEffect, useMemo, useState } from "react";
import {
  getWantListMatches,
  type FriendCopy,
  type WantListMatches,
} from "../social_generated";
import type { WantList } from "../want_list_generated";

/** Friends' cards for the Want List on the page: Friends' copies by the Edition of the card they match. */
export type FriendMatches =
  | { kind: "none" }
  | {
      kind: "ready";
      hasFriends: boolean;
      /** True while the answer for the page's scope and Want List isn't in (loading, or its read failed). */
      pending: boolean;
      byCard: Map<string, FriendCopy[]>;
    };

const NONE: FriendMatches = { kind: "none" };

/**
 * Friends' cards for the Want List answer on the page (#251): GET /api/social/want-list-matches for the same scope,
 * read after the Want List and apart from it, so its revisions, its cost and its export never wait on Friends. It reads
 * again when the answer changes (another scope, or a Deck List, Holding, setting or Will accept change). Until the first answer is in, and when
 * the first read fails, there are no Friends' cards: the page is the Want List without them. A re-read that fails keeps
 * the last answer, with `pending` set.
 */
export function useFriendMatches(
  list: WantList | null,
  refresh: number
): FriendMatches {
  const [state, setState] = useState<{
    key: string;
    answer: WantListMatches;
  } | null>(null);
  const key = list
    ? [
        list.deck_id ?? "",
        list.settings_revision,
        list.owner_revision,
        list.deck_lists_digest,
        refresh,
      ].join(":")
    : "";

  useEffect(() => {
    if (!list) return;
    const controller = new AbortController();
    getWantListMatches({ deck: list.deck_id }, controller.signal).then(
      (answer) => {
        if (!controller.signal.aborted) setState({ key, answer });
      },
      () => {
        // A failed re-read keeps the last answer: the switch stays, and `pending` says the cards aren't current.
      }
    );
    return () => controller.abort();
  }, [key]);

  const scope = list?.deck_id ?? "";
  return useMemo(() => {
    // The last answer stays up while the next one loads, so the switch doesn't flicker, but another scope's cards are
    // never shown against this one.
    if (!state || key === "") return NONE;
    const sameScope = state.key.split(":")[0] === scope;
    return {
      kind: "ready",
      hasFriends: state.answer.has_friends,
      pending: state.key !== key,
      byCard: new Map(
        sameScope
          ? state.answer.cards.map((card) => [card.edition_id, card.copies])
          : []
      ),
    };
  }, [state, scope, key]);
}
