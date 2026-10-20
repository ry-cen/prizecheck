import { loansEnding } from "../loans/loanText";
import type { LoanView, TradeView } from "../social_generated";

/**
 * What Remove Friend or Block would end with one collector (#260, Trading #274): the open Loans nobody has handed
 * over, the Trade Proposals either way, and the accepted Trades nobody has confirmed the swap for, which it cancels;
 * and the Trades one side has confirmed, which stay open so the other side can finish them.
 */
export type FriendshipEnding = {
  loans: number;
  proposals: number;
  trades: number;
  staying: number;
};

/**
 * The Trades part of `FriendshipEnding`, by the same rule as the API's `end_trades_between`, over the Trades list's
 * read, which lists every open Trade: a proposal is cancelled whoever sent it, an accepted Trade only while neither
 * side has confirmed the swap.
 */
export function tradesEnding(
  trades: readonly TradeView[],
  collectorId: string
): Omit<FriendshipEnding, "loans"> {
  const theirs = trades.filter(
    (trade) => trade.other.collector_id === collectorId
  );
  const accepted = theirs.filter((trade) => trade.state === "accepted");
  return {
    proposals: theirs.filter((trade) => trade.state === "proposed").length,
    trades: accepted.filter(
      (trade) => !trade.you_confirmed_swap && !trade.they_confirmed_swap
    ).length,
    staying: accepted.filter(
      (trade) => trade.you_confirmed_swap !== trade.they_confirmed_swap
    ).length,
  };
}

/** What Remove Friend or Block would end with this collector, from the Loans tab's and the Trades list's reads. */
export function friendshipEnding(
  loans: readonly LoanView[],
  trades: readonly TradeView[],
  collectorId: string
): FriendshipEnding {
  return {
    loans: loansEnding(loans, collectorId),
    ...tradesEnding(trades, collectorId),
  };
}

/** "a", "a and b", "a, b and c". */
function joined(parts: string[]): string {
  return parts.length <= 1
    ? parts.join("")
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The sentences Remove Friend's and Block's question adds (prototype "Proposed wording"): "This cancels 1 open Loan
 * that hasn't been handed over, 1 Trade Proposal and 1 Trade that hasn't been swapped. 1 Trade that one of you has
 * confirmed stays open so it can finish." Each part only when there is one; "" when nothing is cancelled or stays.
 */
export function endingText(ending: FriendshipEnding): string {
  const parts: string[] = [];
  if (ending.loans > 0)
    parts.push(
      ending.loans === 1
        ? "1 open Loan that hasn't been handed over"
        : `${ending.loans} open Loans that haven't been handed over`
    );
  if (ending.proposals > 0)
    parts.push(
      ending.proposals === 1
        ? "1 Trade Proposal"
        : `${ending.proposals} Trade Proposals`
    );
  if (ending.trades > 0)
    parts.push(
      ending.trades === 1
        ? "1 Trade that hasn't been swapped"
        : `${ending.trades} Trades that haven't been swapped`
    );
  const sentences = parts.length ? [`This cancels ${joined(parts)}.`] : [];
  if (ending.staying > 0)
    sentences.push(
      ending.staying === 1
        ? "1 Trade that one of you has confirmed stays open so it can finish."
        : `${ending.staying} Trades that one of you has confirmed stay open so they can finish.`
    );
  return sentences.join(" ");
}
