import type { FriendCopy, PendingLine, WaitingLine } from "../social_generated";

/**
 * What one Deck is waiting on from Friends (`GET /api/loans/pending`): copies asked for and copies promised but not yet
 * received, per card. Information only; the Want List's counts never take it off what is still needed.
 *
 * - `idle`: no Deck read covers this Deck.
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

/** `GET /api/loans/waiting` as each of the borrower's Decks' pending lines, per Edition, lenders in server order.
 * Unsorted requests (`deck_id` null) belong to no Deck and are left out. */
export function waitingByDeck(
  lines: WaitingLine[]
): Map<string, Map<string, PendingLine>> {
  const byDeck = new Map<string, Map<string, PendingLine>>();
  for (const line of lines) {
    if (line.deck_id === null) continue;
    let editions = byDeck.get(line.deck_id);
    if (!editions) byDeck.set(line.deck_id, (editions = new Map()));
    let found = editions.get(line.edition_id);
    if (!found)
      editions.set(
        line.edition_id,
        (found = {
          edition_id: line.edition_id,
          requested: "0",
          accepted: "0",
          lenders: [],
        })
      );
    found.lenders.push({
      lender: line.lender,
      lender_id: line.lender_id,
      state: line.state,
      copies: line.copies,
    });
    found[line.state] = String(Number(found[line.state]) + Number(line.copies));
  }
  return byDeck;
}

/** One card's coverage across the Decks that need it (Get from Friends on All Decks): each Deck counts at most its own
 * need; lenders from every one of those Decks, so requestedFrom sees your asks to that Friend for them. */
export function rowCoverage(
  decks: { deck_id: string; need: string }[],
  editionId: string,
  forDeck: (deckId: string) => PendingState
): PendingLine | undefined {
  let covered = 0;
  let found = false;
  const lenders: PendingLine["lenders"] = [];
  for (const { deck_id, need } of decks) {
    const state = forDeck(deck_id);
    if (state.kind !== "ready") continue;
    const line = state.lines.get(editionId);
    if (!line) continue;
    found = true;
    covered += Math.min(
      Number(need),
      Number(line.requested) + Number(line.accepted)
    );
    lenders.push(...line.lenders);
  }
  return found
    ? {
        edition_id: editionId,
        requested: String(covered),
        accepted: "0",
        lenders,
      }
    : undefined;
}

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
  // `limit` is the Friend's real availability: your own requests lower `cap`, never what a draft may keep.
  return {
    cap,
    quantity: borrowDefault(cap, spare, cap),
    limit: Number(copy.spare) + Number(copy.in_deck),
  };
}
