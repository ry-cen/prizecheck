import { useId } from "react";
import type { SurplusHolding } from "../../decks_generated";
import { surplusCards, surplusTotal } from "../surplusModel";
import { plural } from "./importModel";

/**
 * Replace list…'s pieces of the import screens (#215): the destination on the paste screen and in the review's side
 * column, and the side column's Will become Surplus. The preview lists the Deck's copies the new list doesn't cover,
 * with the deck builder's own Surplus words (surplusModel), because after saving the builder's Surplus group shows
 * exactly these cards.
 */

/** The paste screen's destination. */
export function ReplacePasteDestination({ name }: { name: string }) {
  return (
    <div>
      <p className="m-0 text-meta text-text-muted">Put it in</p>
      <p className="m-0 text-body font-semibold">Replace this Deck's list</p>
      <p className="m-0 text-meta text-text-muted">
        Cards the new list doesn't name become Surplus in {name}.
      </p>
    </div>
  );
}

/** The review side column's destination. */
export function ReplaceReviewDestination({ name }: { name: string }) {
  return (
    <p className="m-0 text-body">
      Replacing <strong className="font-semibold">{name}</strong>'s Deck List
    </p>
  );
}

/** Will become Surplus: what the Deck holds beyond the new list. Nothing moves when it is saved. */
export function WillBecomeSurplus({
  rows,
  name,
}: {
  rows: readonly SurplusHolding[];
  name: string;
}) {
  const headingId = useId();
  const cards = surplusCards(rows);
  const total = surplusTotal(cards);
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-1 border-t border-border pt-3"
    >
      <h2 id={headingId} className="m-0 text-body font-semibold">
        Will become Surplus{" "}
        <span className="font-normal tabular-nums text-text-muted">
          · {plural(Number(total), "card")}
        </span>
      </h2>
      {cards.length > 0 ? (
        <>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-meta">
            {cards.map((card) => (
              <li key={card.editionId} className="wrap-anywhere">
                <span className="font-semibold tabular-nums">
                  {card.quantity.toString()}
                </span>{" "}
                {card.name}{" "}
                <span className="text-text-muted">{card.edition}</span>
              </li>
            ))}
          </ul>
          <p className="m-0 text-meta text-text-muted">
            They stay in {name} until you put them away.
          </p>
        </>
      ) : (
        <p className="m-0 text-meta text-text-muted">
          Every card in this Deck is on the new list.
        </p>
      )}
    </section>
  );
}
