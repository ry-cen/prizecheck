import type { FriendCopy, PendingLine } from "../social_generated";

/**
 * What one Deck is waiting on from Friends (`GET /api/loans/pending`): copies asked for and copies promised but not yet
 * received, per card. Information only; the Want List's counts never take it off what is still needed.
 *
 * - `idle`: no Deck in scope (All Decks shows none).
 * - `loading`: the first read for this Deck.
 * - `ready`: its answer; `stale` once a later read failed, so the screen says it may be out of date and never shows 0.
 * - `failed`: the first read failed; the screen says so instead of showing nothing asked for.
 */
export type PendingState =
  | { kind: "idle" }
  | { kind: "loading"; deckId: string }
  | {
      kind: "ready";
      deckId: string;
      lines: Map<string, PendingLine>;
      stale: boolean;
    }
  | { kind: "failed"; deckId: string };

/** The line's pending note, e.g. "Misty W. agreed to lend 1 · Asked Brock S. for 2", or "" when nothing waits. */
export function pendingText(line: PendingLine | undefined): string {
  if (!line) return "";
  return line.lenders
    .map((who) =>
      who.state === "accepted"
        ? `${who.lender} agreed to lend ${who.copies}`
        : `Asked ${who.lender} for ${who.copies}`
    )
    .join(" · ");
}

/** Deck coverage and the offered Edition's unreserved requests are different quantities. */
export function borrowRemainder(
  need: number,
  available: number,
  coverage: PendingLine | undefined,
  offered: PendingLine | undefined,
  lenderId: string
): number {
  const asked = requestedFrom(offered, lenderId);
  const covered =
    Number(coverage?.requested ?? 0) + Number(coverage?.accepted ?? 0);
  return Math.max(0, Math.min(need - covered, available - asked));
}

/** Prefer spare copies; a Friend can also choose to lend cards from a Deck. */
export function borrowDefault(
  need: number,
  spare: number,
  cap: number
): number {
  return Math.max(0, Math.min(need, spare > 0 ? spare : cap, cap));
}

function requestedFrom(
  line: PendingLine | undefined,
  lenderId: string
): number {
  return (
    line?.lenders
      .filter((who) => who.lender_id === lenderId && who.state === "requested")
      .reduce((total, who) => total + Number(who.copies), 0) ?? 0
  );
}

/** One source for both the offer's cap and its initial quantity. */
export function borrowOffer(
  need: number,
  copy: Pick<FriendCopy, "collector_id" | "spare" | "in_deck">,
  coverage: PendingLine | undefined,
  offered: PendingLine | undefined
) {
  const cap = borrowRemainder(
    need,
    Number(copy.spare) + Number(copy.in_deck),
    coverage,
    offered,
    copy.collector_id
  );
  const spare = Math.max(
    0,
    Number(copy.spare) - requestedFrom(offered, copy.collector_id)
  );
  return { cap, quantity: borrowDefault(cap, spare, cap) };
}
