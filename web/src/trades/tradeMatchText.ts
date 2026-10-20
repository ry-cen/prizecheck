import type { TradeMatchCard, TradeMatchRow } from "../social_generated";

/** The match kind's tag (prototype verdict variant A). A one-way row reads as a possible sale or purchase only while
 * that Friend is Open to cash offers (owner, 2026-10-19); otherwise it has no tag and the headline says it. */
export function matchTag(row: TradeMatchRow): string | null {
  switch (row.match) {
    case "two_way":
      return "Two-way match";
    case "has_what_you_want":
      return row.open_to_cash_offers ? "You could buy" : null;
    case "wants_what_you_have":
      return row.open_to_cash_offers ? "You could sell" : null;
    default:
      return null;
  }
}

const cards = (n: number) => (n === 1 ? "1 card" : `${n} cards`);

/** How many cards a side carries in all, the ones past the first 20 included. */
export function sideCount(row: TradeMatchRow, side: "get" | "give"): number {
  return side === "get"
    ? row.you_get.length + row.more_you_get
    : row.you_give.length + row.more_you_give;
}

/** The row's headline (prototype "matchHeadline"): "Ash K. has 3 cards you want and wants 2 of yours", "Ash K. has 1
 * card you want", "Ash K. wants 2 of your cards". Counts are cards (Card Editions), not copies. */
export function matchHeadline(row: TradeMatchRow): string {
  const name = row.display_name;
  const get = sideCount(row, "get");
  const give = sideCount(row, "give");
  if (get > 0 && give > 0)
    return `${name} has ${cards(get)} you want and wants ${give} of yours`;
  if (get > 0) return `${name} has ${cards(get)} you want`;
  if (give > 0)
    return `${name} wants ${give} of your ${give === 1 ? "card" : "cards"}`;
  return `No match with ${name} right now`;
}

/** How many the receiving side wants (prototype "wantText"): "6 wanted (2 for Decks)" when a Deck wants some, else
 * "4 wanted". It never names a Deck. */
export function wantText(card: TradeMatchCard): string {
  return card.origin === "trade_wants"
    ? `${card.need} wanted`
    : `${card.need} wanted (${card.want_list_need} for Decks)`;
}

/** Where the want comes from: a Deck, the Trade Wants list, or both. */
export function originText(card: TradeMatchCard): string {
  switch (card.origin) {
    case "want_list":
      return "For Decks";
    case "trade_wants":
      return "For Trade Wants";
    case "both":
      return "For Decks and Trade Wants";
  }
}

/** How a card the collector would get matches their want (prototype "ACC"): the narrowest way. */
export function acceptsText(card: TradeMatchCard): string | null {
  switch (card.accepts_as) {
    case "exact":
      return "Exact";
    case "any_finish":
      return "Any finish";
    case "same_name":
      return "Same name";
    default:
      return null;
  }
}

/** One tap's worth of a suggested card: as many as are wanted, never more than are offered, at least one. */
export function suggestedQuantity(card: TradeMatchCard): number {
  return Math.max(1, Math.min(Number(card.copies), Number(card.need)));
}
