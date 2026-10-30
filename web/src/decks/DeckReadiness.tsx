import type { DeckLine } from "./deckListModel";
import { deckReadiness } from "./deckReadiness";

/**
 * Header row 1's readiness (finish-deck flow): where the Deck List's copies are, as four counts that add up to it — in
 * this Deck, owned elsewhere, lent out and not owned — the same split the copies are drawn in. Gather N brings the
 * copies owned elsewhere; Buy missing and the Want List say what to get under the counting setting, which can differ
 * from "not owned", so no to-get count is shown here. Owned elsewhere reserves nothing, so it is never called
 * available. Nothing renders for an empty Deck List.
 */
export function DeckReadiness({ lines }: { lines: readonly DeckLine[] }) {
  const parts = deckReadiness(lines);
  if (parts.total === 0n) return null;
  if (parts.inDeck === parts.total)
    return (
      <p className="m-0 text-meta text-text-muted">
        Every card is in this Deck.
      </p>
    );
  const counts = [
    { label: "In this Deck", value: parts.inDeck },
    { label: "Owned elsewhere", value: parts.elsewhere },
    { label: "Lent out", value: parts.lent },
    { label: "Not owned", value: parts.notOwned },
  ];
  return (
    <div
      role="group"
      aria-label="Where this Deck's cards are"
      className="min-w-0"
    >
      <dl className="m-0 flex flex-wrap gap-x-4 gap-y-1 text-meta">
        {counts.map(({ label, value }) => (
          <div key={label} className="flex items-baseline gap-1">
            <dt className="text-text-muted">{label}</dt>
            <dd className="m-0 font-semibold tabular-nums">
              {value.toString()}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
