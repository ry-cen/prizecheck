import type { DeckCostFigures } from "../prices_generated";
import type { DeckCostSettled } from "./useDeckCost";

/**
 * One figure as the header reads it: "$123.45 deck (52/58 priced)". An empty figure has no copies to price
 * ("$0.00 to complete"); a figure with no cached price says so; an incomplete or missing one is unavailable.
 */
export function figureText(
  figure: DeckCostFigures | undefined,
  noun: "deck" | "to complete"
): string {
  const coverage = `(${figure?.priced_copies ?? "0"}/${figure?.total_copies ?? "0"} priced)`;
  switch (figure?.status) {
    case "priced":
      return `${figure.display_amount} ${noun} ${coverage}`;
    case "empty":
      return `${figure.display_amount ?? "$0.00"} ${noun}`;
    case "no_quotes":
      return noun === "deck"
        ? `Deck unpriced ${coverage}`
        : `To complete unpriced ${coverage}`;
    default:
      return noun === "deck"
        ? "Deck price unavailable"
        : "Price to complete unavailable";
  }
}

/**
 * Header row 1's cost (#176): the Deck List cost and the cost to complete, each with how many copies have a
 * price, from the page's one cost read (useDeckCost).
 */
export function DeckCostLine({ settled }: { settled: DeckCostSettled }) {
  const text = !settled
    ? "Checking prices…"
    : settled.kind === "unavailable"
      ? `${figureText(undefined, "deck")} · ${figureText(undefined, "to complete")}`
      : `${figureText(settled.cost.deck_list_cost, "deck")} · ${figureText(
          settled.cost.cost_to_complete,
          "to complete"
        )}`;
  return <p className="m-0 text-meta tabular-nums text-text-muted">{text}</p>;
}
