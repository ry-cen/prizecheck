import type { TreeLocation } from "../location_generated";
import type { LoanSide, LoanView, TradeView } from "../social_generated";
import type { DeckSwitchRequest, OwnTradeSide } from "../trades_generated";

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** A single intervening confirmation can be retried; any additional revision needs review. */
function otherConfirmed(
  before: { revision: number },
  after: { revision: number },
  mine: boolean,
  wasTheirs: boolean,
  nowMine: boolean,
  nowTheirs: boolean
) {
  return (
    after.revision === before.revision + 1 &&
    !mine &&
    !wasTheirs &&
    !nowMine &&
    nowTheirs
  );
}

export function canRetrySwap(
  before: TradeView,
  after: TradeView,
  side: OwnTradeSide,
  nextSide: OwnTradeSide
) {
  const terms = (trade: TradeView) => [
    trade.id,
    trade.state,
    trade.role,
    trade.other,
    trade.countered_from,
    trade.you_give,
    trade.you_get,
    trade.cash,
  ];
  return (
    before.state === "accepted" &&
    after.actions.includes("confirm_swap") &&
    otherConfirmed(
      before,
      after,
      before.you_confirmed_swap,
      before.they_confirmed_swap,
      after.you_confirmed_swap,
      after.they_confirmed_swap
    ) &&
    same(terms(before), terms(after)) &&
    same(side.picks, nextSide.picks) &&
    nextSide.suggested.length === 0 &&
    nextSide.picks.every((pick) => Number(pick.short) === 0)
  );
}

export function canRetryHandover(
  before: LoanView,
  after: LoanView,
  side: LoanSide,
  nextSide: LoanSide
) {
  const terms = (loan: LoanView) => [
    loan.id,
    loan.state,
    loan.kind,
    loan.role,
    loan.other,
    loan.lines,
    loan.return_by,
    loan.pending_return,
    loan.extension_to,
    loan.awaiting_choice,
  ];
  return (
    before.state === "accepted" &&
    after.actions.includes("confirm_handover") &&
    otherConfirmed(
      before,
      after,
      before.you_confirmed_handover,
      before.they_confirmed_handover,
      after.you_confirmed_handover,
      after.they_confirmed_handover
    ) &&
    same(terms(before), terms(after)) &&
    same(side.deck, nextSide.deck) &&
    same(side.picks, nextSide.picks) &&
    nextSide.suggested.length === 0 &&
    nextSide.picks.every((pick) => Number(pick.short) === 0)
  );
}

/** Keep exactly the collector's choices, provided they are still offered and the destination remains a leaf. */
export function canKeepSwapChoices(
  side: OwnTradeSide,
  locations: TreeLocation[],
  destination: string | null,
  switches: DeckSwitchRequest[]
) {
  const place = locations.find((item) => item.id === destination);
  const validDestination =
    destination === null ||
    (place &&
      place.kind !== "organization" &&
      !locations.some((item) => item.parent_id === place.id));
  return (
    Boolean(validDestination) &&
    switches.every((offer) =>
      side.deck_switches.some(
        (current) =>
          offer.deck_id === current.deck_id &&
          offer.from_edition_id === current.from_edition_id &&
          offer.to_edition_id === current.to_edition_id &&
          offer.count === current.count
      )
    )
  );
}
