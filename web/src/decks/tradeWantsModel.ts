import type { SetWillAccept, TradeWants } from "../trades_generated";
import { editionText } from "./wantListModel";

/** A Will accept choice (Trading #275): this exact card, any finish of its Card Printing, or any card with the same
 * Card Identity. */
export type WillAcceptRule = SetWillAccept["rule"];

/** The choices, in the order the select lists them, in plain words. */
export const WILL_ACCEPT_OPTIONS: { value: WillAcceptRule; label: string }[] = [
  { value: "edition", label: "This exact card" },
  { value: "printing", label: "Any finish" },
  { value: "identity", label: "Any card with the same name" },
];

/** Lines one collector's Trade Wants may hold (api/app/trade_wants.py MAX_TRADE_WANTS). */
export const MAX_TRADE_WANTS = 500;
/** Copies one Trade Wants line may name. */
export const MAX_TRADE_WANT_COPIES = 9999;

/** Said when a new line would pass the cap (422 TOO_MANY_LINES). */
export const TRADE_WANTS_FULL = `You can have up to ${MAX_TRADE_WANTS} Trade Wants. Remove one to add another.`;

type Card = {
  name: string;
  set_name: string;
  collector_number: string;
  descriptor: Record<string, unknown>;
};

/** A card as the Trade Wants and Will accept wording names it: "Iono (Paldea Evolved · 185 · Normal)". */
export function cardText(card: Card): string {
  return `${card.name} (${editionText(card)})`;
}

/** Each widened choice by Card Edition id; an Edition that isn't here is this exact card. */
export function rulesOf(wants: TradeWants): Map<string, WillAcceptRule> {
  return new Map(
    wants.will_accept.map((choice) => [choice.edition_id, choice.rule])
  );
}

/** The toast after a choice: "Trades will match any finish for Iono (Paldea Evolved · 185 · Normal)." */
export function willAcceptToast(rule: WillAcceptRule, card: Card): string {
  const label = WILL_ACCEPT_OPTIONS.find(
    (option) => option.value === rule
  )!.label;
  return `Trades will match ${label.charAt(0).toLowerCase()}${label.slice(1)} for ${cardText(card)}.`;
}

/** What a refused Trade Wants change says, by the API's code. */
export function tradeWantsRefusal(code: string | null): string {
  if (code === "TOO_MANY_LINES") return TRADE_WANTS_FULL;
  if (code === "EDITION_UNAVAILABLE")
    return "That card can't be added any more.";
  return "Your Trade Wants couldn't be changed. Try again.";
}
