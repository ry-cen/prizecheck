import { cardCount } from "../loans/loanText";
import {
  SocialError,
  type InboxTradeUpdate,
  type TradeView,
} from "../social_generated";
import {
  TradesError,
  type DeckSwitchOffer,
  type TradePickPlace,
} from "../trades_generated";
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

/** Whole US cents as dollars: "1500" is "$15.00", "99999999" is "$999,999.99". Integer arithmetic only. */
export function formatCents(cents: string): string {
  const n = Number(cents);
  const dollars = Math.floor(n / 100).toLocaleString("en-US");
  return `$${dollars}.${String(n % 100).padStart(2, "0")}`;
}

/** The cash line of a Trade from the reader's side: "You pay Ash K $15.00" or "Ash K pays you $15.00". */
export function tradeCashText(
  cash: { cents: string; payer: "you" | "them" },
  name: string
): string {
  const money = formatCents(cash.cents);
  return cash.payer === "you"
    ? `You pay ${name} ${money}`
    : `${name} pays you ${money}`;
}

/** The refusal for an amount the server won't take (and the local check's message). */
export const INVALID_CASH_TEXT = "Enter an amount from $0.01 to $999,999.99.";

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
      if (trade.you_get.length === 0 && trade.cash?.payer === "them")
        return `${n} would pay ${formatCents(trade.cash.cents)} for ${cardCount(sideCopies(trade.you_give))}`;
      if (trade.you_give.length === 0 && trade.cash?.payer === "you")
        return `${n} would sell you ${cardCount(sideCopies(trade.you_get))} for ${formatCents(trade.cash.cents)}`;
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

/**
 * The one note under the person row, or "" (prototype "Proposed wording"): an out-of-date pick first, then what the
 * swap waits on. `stale`: one of the reader's own picks is out of date.
 */
export function tradeNote(trade: TradeView, stale: boolean): string {
  if (trade.state === "closed") return "";
  if (stale) return "A pick is out of date.";
  if (trade.state !== "accepted" || trade.you_confirmed_swap) return "";
  if (trade.they_confirmed_swap)
    return `${trade.other.display_name} confirmed the swap. Confirm yours once you have the cards.`;
  return "Swap the cards in person, then confirm.";
}

/** Where the reader's picks take one card's copies from: "From Binder 1", or each place with its copies. Only the
 * reader's own Locations, from their own side read. `lower`: "from …", inside the confirm dialog's line. */
export function tradePickText(
  places: readonly TradePickPlace[],
  editionId: string,
  lower = false
): string | null {
  const found = places.filter((place) => place.edition_id === editionId);
  if (found.length === 0) return null;
  const from = lower ? "from" : "From";
  if (found.length === 1) return `${from} ${found[0].name}`;
  return `${from} ${found.map((place) => `${place.name} (${place.copies})`).join(" · ")}`;
}

/**
 * Each out-of-date pick of one card (prototype "Proposed wording"): "Binder 1 has none now · take it from Box", or
 * "Binder 1 has only 1 now · take them from Box" when part of the pick is still there. The places named after "take"
 * are those the suggested picks add, named on the card's last out-of-date pick only.
 */
export function tradeStaleText(
  picks: readonly TradePickPlace[],
  suggested: readonly TradePickPlace[],
  editionId: string
): { key: string; text: string }[] {
  const mine = picks.filter((place) => place.edition_id === editionId);
  const stale = mine.filter((place) => place.short !== "0");
  if (stale.length === 0) return [];
  const kept = new Map<string | null, number>();
  for (const place of mine)
    kept.set(
      place.location_id,
      (kept.get(place.location_id) ?? 0) +
        Number(place.copies) -
        Number(place.short)
    );
  const added = suggested
    .filter((place) => place.edition_id === editionId)
    .map((place) => ({
      name: place.name,
      copies: Number(place.copies) - (kept.get(place.location_id) ?? 0),
    }))
    .filter((place) => place.copies > 0);
  const short = stale.reduce((total, place) => total + Number(place.short), 0);
  const take =
    added.length === 0
      ? ""
      : ` · take ${short === 1 ? "it" : "them"} from ${
          added.length === 1
            ? added[0].name
            : added
                .map((place) => `${place.name} (${place.copies})`)
                .join(" · ")
        }`;
  return stale.map((place, index) => {
    const left = Number(place.copies) - Number(place.short);
    return {
      // Keyed by the Location: two Locations can share a leaf name.
      key: place.location_id ?? `place-${index}`,
      text:
        (left > 0
          ? `${place.name} has only ${left} now`
          : `${place.name} has none now`) +
        (index === stale.length - 1 ? take : ""),
    };
  });
}

/** The toast after the reader's Confirm swap (prototype "Proposed wording"). `destination`: where the cards they got
 * went, as the picker named it, or null when they got none. */
export function swapDoneMessage(
  trade: TradeView,
  destination: string | null
): string {
  if (destination === null || trade.you_get.length === 0)
    return "Swapped. The cards you gave left your Collection.";
  const n = sideCopies(trade.you_get);
  return `Swapped. ${n} ${n === 1 ? "card is" : "cards are"} in ${destination}.`;
}

/** The Confirm swap dialog's checkbox text for one Deck switch offer (Trading #279). */
export function switchOfferText(offer: DeckSwitchOffer): string {
  return `Use for ${offer.deck_name} instead of ${tradeCardName(offer.from_card)}?`;
}

/** The line under an offer's checkbox. */
export function switchHelpText(offer: DeckSwitchOffer): string {
  return `The Deck's list changes to the card you get: ${tradeCardName(offer.to_card)} ×${offer.count}.`;
}

function switchedDecks(sent: readonly DeckSwitchOffer[]): number {
  return new Set(sent.map((offer) => offer.deck_id)).size;
}

/** The toast sentence after the switches that were sent (no leading space), or "" for none. */
export function switchDoneText(sent: readonly DeckSwitchOffer[]): string {
  const [only] = sent;
  if (!only) return "";
  if (sent.length === 1)
    return `${only.deck_name} now uses ${tradeCardName(only.to_card)}.`;
  const decks = switchedDecks(sent);
  return decks === 1
    ? `${only.deck_name} now uses the cards you got.`
    : `${decks} Decks now use the cards you got.`;
}

/** The toast text once every switch was undone. */
export function switchUndoneText(sent: readonly DeckSwitchOffer[]): string {
  const [only] = sent;
  if (!only) return "";
  if (sent.length === 1)
    return `${only.deck_name} uses ${tradeCardName(only.from_card)} again.`;
  return switchedDecks(sent) === 1
    ? `${only.deck_name} uses its cards again.`
    : "Your Decks use their cards again.";
}

/** The toast action's label. */
export function switchUndoLabel(
  sent: readonly DeckSwitchOffer[]
): "Undo switch" | "Undo switches" {
  return sent.length > 1 ? "Undo switches" : "Undo switch";
}

/**
 * What a Trade waits on the reader for, as the inbox's line says it after the name (prototype inbox drawer, Trading
 * #273): "Answer", "Fix picks" or "Confirm swap"; null when it waits on nobody. A Counter is answered the same way
 * and reads "Answer Counter" (#278).
 */
export function tradeWaitingLabel(
  trade: Pick<TradeView, "waiting" | "countered_from">
): string | null {
  switch (trade.waiting) {
    case "answer":
      return trade.countered_from ? "Answer Counter" : "Answer";
    case "fix_picks":
      return "Fix picks";
    case "confirm_swap":
      return "Confirm swap";
    default:
      return null;
  }
}

/**
 * A Trade update under the inbox's Earlier (prototype "Proposed wording", Trading #273), from the reader's side: "Kim
 * accepted your Trade Proposal", "Kim cancelled this Trade", "Kim confirmed the swap". It never says why: a Trade
 * cancelled for any reason reads like any other cancel.
 */
export function tradeUpdateText(update: InboxTradeUpdate): string {
  const other = update.other_name;
  switch (update.kind) {
    case "accepted":
      return `${other} accepted your Trade Proposal`;
    case "declined":
      return `${other} declined your Trade Proposal`;
    case "cancelled":
      return `${other} cancelled this Trade`;
    case "withdrawn":
      return `${other} withdrew their Trade Proposal`;
    case "swapped":
      return `${other} confirmed the swap`;
  }
}

/** "You give 2 cards · You get nothing", then " · Misty W pays you $15.00" when the Trade has cash. */
export function tradeSubline(trade: TradeView): string {
  const give = trade.you_give.length
    ? cardCount(sideCopies(trade.you_give))
    : "nothing";
  const get = trade.you_get.length
    ? cardCount(sideCopies(trade.you_get))
    : "nothing";
  const cash = trade.cash
    ? ` · ${tradeCashText(trade.cash, trade.other.display_name)}`
    : "";
  return `You give ${give} · You get ${get}${cash}`;
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
 * What a Trade Proposal or Counter that couldn't be sent says (prototype "Proposed wording" where it has one). `friend`
 * is the Friend's Display Name; `give` and `get` are the lines, named from the sender's or counterer's view, to name
 * the card a refusal is about. `what` says whether it was a proposal or a Counter (#278).
 */
export function sendTradeMessage(
  cause: unknown,
  friend: string,
  give: readonly NamedLine[],
  get: readonly NamedLine[],
  what: "proposal" | "counter" = "proposal"
): string {
  if (tradeOutcomeUnknown(cause))
    return what === "counter"
      ? "The Counter may not have been sent. Check your connection and try again."
      : "The Trade Proposal may not have been sent. Check your connection and try again.";
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
    case "INVALID_CASH":
      return INVALID_CASH_TEXT;
    case "CASH_ONLY_NOT_OPEN":
      return error.detail.side === "you_get"
        ? `${friend} isn't open to cash offers, so ${friend} can't give only cash. Add a card from ${friend}'s Trade List, or remove the cash.`
        : `${friend} isn't open to cash offers, so you can't give only cash. Add a card from your Trade List, or remove the cash.`;
    case "NOT_FRIENDS":
      return `${friend} isn't one of your Friends anymore.`;
    case "TOO_MANY_CHANGES":
      return `Too many changes. Try again in ${minutes(error.detail)}.`;
    default:
      return what === "counter"
        ? "The Counter couldn't be sent. Check it and try again."
        : "The Trade Proposal couldn't be sent. Check it and try again.";
  }
}

/** A Counter refused because the proposal changed, but it still waits for the reader's answer (Trading #278). */
export const COUNTER_CHANGED_TEXT =
  "This Trade Proposal changed. Check your Counter, then send it again.";

/** A Counter refused because the proposal no longer waits for the reader's answer (Trading #278). */
export const COUNTER_GONE_TEXT =
  "This Trade Proposal isn't waiting for your answer anymore, so your Counter can't be sent.";

/**
 * What a Trade step that failed says (prototype "Proposed wording" where it has one). `trade` is the Trade the step
 * was taken on, to name the other side and the card a refusal is about.
 */
export function tradeStepMessage(cause: unknown, trade: TradeView): string {
  if (tradeOutcomeUnknown(cause))
    return "The Trade may not have been updated. Check your connection and try again.";
  const error = cause as SocialError | TradesError;
  switch (error.code) {
    case "NOT_TRADEABLE": {
      // Only an accept refuses this way, for a card the reader gives.
      const instead = trade.actions.includes("counter")
        ? "Send a Counter or decline it instead."
        : "Decline it instead.";
      const n = String(error.detail.available ?? "0");
      const line = trade.you_give.find(
        (card) => card.edition_id === String(error.detail.edition_id ?? "")
      );
      const card = line ? tradeCardName(line) : "A card";
      return n === "0"
        ? `${card} isn't on your Trade List now, so you can't accept this. ${instead}`
        : `You can trade only ${n} ${card} now, so you can't accept this. ${instead}`;
    }
    case "NOT_FRIENDS":
      return `${trade.other.display_name} isn't one of your Friends anymore.`;
    case "TRADE_CHANGED":
    case "STEP_NOT_ALLOWED":
      return "This Trade has changed. Check it and try again.";
    case "TRADE_NOT_FOUND":
      return "This Trade can't be found.";
    // Confirm swap and Use suggested picks (#272).
    case "PICKS_OUT_OF_DATE":
      return "A pick is out of date. Use the suggested picks first.";
    case "PICKS_UP_TO_DATE":
      return "Your picks are already up to date.";
    case "DECK_SWITCH_CHANGED":
      return "Your Decks changed since you opened this, so nothing was swapped. Check the Deck switches and confirm again.";
    case "UNSORTED_UNAVAILABLE":
      return "Your top-level Unsorted can't hold cards. Choose another place for the cards you get, or make Unsorted a Storage Leaf in Collection.";
    case "LOCATION_NOT_FOUND":
      return "That place isn't in your Collection now. Choose another place for the cards you get.";
    case "TOO_MANY_CHANGES":
      return `Too many changes. Try again in ${minutes(error.detail)}.`;
    default:
      return "The Trade couldn't be updated. Check it and try again.";
  }
}
