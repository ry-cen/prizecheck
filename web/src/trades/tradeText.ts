import { cardCount } from "../loans/loanText";
import { SocialError, type TradeView } from "../social_generated";
import { TradesError } from "../trades_generated";
import { variantLabel } from "../ui/variantLabel";

/** A card as the Trade messages name it (prototype "Proposed wording"): "Iono (PAL 185)". A finish other than Normal
 * follows the number, so two Editions of one card never share a name: "Arven (SVI 166, Reverse Holo)". */
export function tradeCardName(card: {
  name: string;
  set_code: string;
  collector_number: string;
  descriptor: Record<string, unknown>;
}): string {
  const finish = variantLabel(card.descriptor);
  return `${card.name} (${card.set_code} ${card.collector_number}${finish === "Normal" ? "" : `, ${finish}`})`;
}

/** The copies one side of a Trade gives. */
export function sideCopies(cards: readonly { copies: string }[]): number {
  return cards.reduce((total, card) => total + Number(card.copies), 0);
}

/**
 * The plain-language headline from the reader's side (prototype verdict variant A): "Ash K. sent you a Trade
 * Proposal", "Waiting for Ash K. to answer", "You withdrew this Trade Proposal". It names no Location, Deck or reason.
 */
export function tradeHeadline(trade: TradeView): string {
  const n = trade.other.display_name;
  const you = trade.closed_by === "you";
  switch (trade.state) {
    case "proposed":
      if (trade.role === "proposer") return `Waiting for ${n} to answer`;
      if (trade.countered_from) return `${n} countered your Trade Proposal`;
      if (trade.you_give.length === 0)
        return `${n} wants to give you ${cardCount(sideCopies(trade.you_get))}`;
      return `${n} sent you a Trade Proposal`;
    case "accepted":
      if (!trade.you_confirmed_swap && !trade.they_confirmed_swap)
        return trade.you_get.length === 0
          ? `Ready to give ${n} ${cardCount(sideCopies(trade.you_give))}`
          : `Ready to swap with ${n}`;
      if (trade.they_confirmed_swap && !trade.you_confirmed_swap)
        return `${n} confirmed the swap`;
      return `Waiting for ${n} to confirm the swap`;
    case "closed":
      switch (trade.closed_reason) {
        case "swapped":
          return `Swapped with ${n}`;
        case "withdrawn":
          return you
            ? "You withdrew this Trade Proposal"
            : `${n} withdrew this Trade Proposal`;
        case "declined":
          return you ? "You declined" : `${n} declined`;
        case "cancelled":
          return you
            ? "You cancelled this Trade"
            : trade.closed_by === "them"
              ? `${n} cancelled this Trade`
              : "This Trade was cancelled";
        case "countered":
          return you ? "You countered this" : `${n} countered this`;
        default:
          return n;
      }
  }
}

/** "You give 2 cards · You get nothing". */
export function tradeSubline(trade: TradeView): string {
  const give = trade.you_give.length
    ? cardCount(sideCopies(trade.you_give))
    : "nothing";
  const get = trade.you_get.length
    ? cardCount(sideCopies(trade.you_get))
    : "nothing";
  return `You give ${give} · You get ${get}`;
}

/** Whether a failed Trade request's outcome is unknown (no answer, or a server error): retry it with the same key. */
export function tradeOutcomeUnknown(cause: unknown): boolean {
  return (
    !(cause instanceof SocialError || cause instanceof TradesError) ||
    cause.status >= 500
  );
}

function minutes(detail: Record<string, unknown>): string {
  const n = Number(detail.retry_after_minutes) || 60;
  return `${n} ${n === 1 ? "minute" : "minutes"}`;
}

/** A draft line as the send messages need it. */
type NamedLine = {
  edition_id: string;
  name: string;
  set_code: string;
  collector_number: string;
  descriptor: Record<string, unknown>;
};

/**
 * What a Trade Proposal that couldn't be sent says (prototype "Proposed wording" where it has one). `friend` is the
 * Friend's Display Name; `give` and `get` are the draft's lines, to name the card a refusal is about.
 */
export function sendTradeMessage(
  cause: unknown,
  friend: string,
  give: readonly NamedLine[],
  get: readonly NamedLine[]
): string {
  if (tradeOutcomeUnknown(cause))
    return "The Trade Proposal may not have been sent. Check your connection and try again.";
  const error = cause as TradesError;
  const named = (id: string) => {
    const line = [...give, ...get].find((item) => item.edition_id === id);
    return line ? tradeCardName(line) : "A card";
  };
  switch (error.code) {
    case "NOT_TRADEABLE": {
      const n = String(error.detail.available ?? "0");
      const card = named(String(error.detail.edition_id ?? ""));
      if (error.detail.side === "you_get")
        return n === "0"
          ? `${friend} doesn't have ${card} on their Trade List now. Remove it, then send again.`
          : `${friend} can trade only ${n} ${card} now. Lower it to ${n}, then send again.`;
      return n === "0"
        ? `${card} isn't on your Trade List now. Remove it, then send again.`
        : `You can trade only ${n} ${card} now. Lower it to ${n}, then send again.`;
    }
    case "SAME_CARD_BOTH_SIDES": {
      const both = give.find((line) =>
        get.some((other) => other.edition_id === line.edition_id)
      );
      return `${both ? tradeCardName(both) : "A card"} can't be on both sides. Remove it from one side, then send again.`;
    }
    case "TRADE_HAS_NO_CARDS":
      return "Add at least one card to either side.";
    case "TOO_MANY_LINES":
      return "A Trade Proposal can list up to 50 cards on each side. Remove some, then send again.";
    case "NOT_FRIENDS":
      return `${friend} isn't one of your Friends anymore.`;
    case "TOO_MANY_CHANGES":
      return `Too many changes. Try again in ${minutes(error.detail)}.`;
    default:
      return "The Trade Proposal couldn't be sent. Check it and try again.";
  }
}

/** What a Trade step that failed says. */
export function tradeStepMessage(cause: unknown): string {
  if (tradeOutcomeUnknown(cause))
    return "The Trade may not have been updated. Check your connection and try again.";
  const error = cause as SocialError;
  switch (error.code) {
    case "TRADE_CHANGED":
    case "STEP_NOT_ALLOWED":
      return "This Trade has changed. Check it and try again.";
    case "TRADE_NOT_FOUND":
      return "This Trade can't be found.";
    case "TOO_MANY_CHANGES":
      return `Too many changes. Try again in ${minutes(error.detail)}.`;
    default:
      return "The Trade couldn't be updated. Check it and try again.";
  }
}
