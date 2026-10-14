import { useEffect, useRef, useState } from "react";
import { getDeckCost, type DeckCost } from "./prices_generated";

// Estimated Deck Cost and Pricing Coverage come from one server-side access over every copy in the Deck, never from
// the rows this page happens to render. A result belongs to one inventory revision: an answer for another revision is
// discarded, and a newer one asks the page to reload its checks (which re-renders this with the new revision).
const CLIENT_TIMEOUT_MS = 3_500;

/** The figures a private Deck's cost summary renders (DeckCost). The Published Deck page has its own cost line (#183). */
export type CostFigures = Pick<
  DeckCost,
  | "status"
  | "total_copies"
  | "priced_copies"
  | "stale_copies"
  | "unknown_age_copies"
  | "fallback_copies"
  | "display_amount"
>;
export type CostSettled =
  { kind: "cost"; cost: CostFigures } | { kind: "unavailable" } | null;

const plural = (count: string, word: string) =>
  `${count} ${word}${count === "1" ? "" : "s"}`;

export function DeckCostSummary({
  deckId,
  ownerRevision,
  totalCopies,
  onNewerRevision,
  headingLevel = 4,
}: {
  deckId: string;
  ownerRevision: number;
  totalCopies: string;
  onNewerRevision: () => void;
  headingLevel?: 2 | 4;
}) {
  const [settled, setSettled] = useState<CostSettled>(null);
  const latest = useRef(ownerRevision);

  useEffect(() => {
    latest.current = ownerRevision;
    setSettled(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
    let live = true;
    getDeckCost(deckId, controller.signal)
      .then((cost) => {
        if (!live) return;
        if (
          cost.owner_revision === null ||
          cost.owner_revision === ownerRevision
        )
          setSettled({ kind: "cost", cost });
        else if (cost.owner_revision > latest.current) onNewerRevision();
        // An older revision belongs to no live request: end the check instead of waiting for an answer that never comes.
        else setSettled({ kind: "unavailable" });
      })
      .catch(() => {
        if (!live) return;
        setSettled({ kind: "unavailable" });
      })
      .finally(() => clearTimeout(timer));
    return () => {
      live = false;
      clearTimeout(timer);
      controller.abort();
    };
    // onNewerRevision is a fresh closure on every render; only the Deck and its revision start a new access.
  }, [deckId, ownerRevision]);

  return (
    <CostSection
      settled={settled}
      totalCopies={totalCopies}
      headingLevel={headingLevel}
    />
  );
}

// Renders a settled cost, or "Checking prices…" while it is null; it never fetches and never sums rows.
export function CostSection({
  settled,
  totalCopies,
  headingLevel = 4,
}: {
  settled: CostSettled;
  totalCopies: string;
  headingLevel?: 2 | 4;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h4";
  let content;
  let status = "checking";
  const unavailable = (total: string) =>
    `Price unavailable; coverage unavailable; ${plural(total, "card")} total`;
  if (!settled) content = <p>Checking prices…</p>;
  else if (settled.kind === "unavailable") {
    status = "incomplete";
    content = <p>{unavailable(totalCopies)}</p>;
  } else {
    const { cost } = settled;
    status = cost.status;
    const total = cost.total_copies ?? totalCopies;
    if (cost.status === "empty")
      content = (
        <p>
          <strong>{cost.display_amount}</strong> · No cards
        </p>
      );
    else if (cost.status === "incomplete")
      content = <p>{unavailable(total)}</p>;
    else if (cost.status === "no_quotes")
      content = (
        <p>
          Price unavailable · {cost.priced_copies}/{total} cards priced
        </p>
      );
    else {
      const unpriced = (
        BigInt(total) - BigInt(cost.priced_copies ?? "0")
      ).toString();
      content = (
        <>
          <p>
            <strong>{cost.display_amount}</strong> · {cost.priced_copies}/
            {total} cards priced
            {unpriced !== "0" && (
              <>
                {" "}
                · Incomplete subtotal: {plural(unpriced, "card")} without a
                price
              </>
            )}
          </p>
          <p>
            {plural(cost.stale_copies ?? "0", "stale card")} (price over 48
            hours old) · {plural(cost.unknown_age_copies ?? "0", "card")} with
            unknown price age
          </p>
        </>
      );
    }
    if (
      cost.fallback_copies &&
      cost.fallback_copies !== "0" &&
      cost.status !== "incomplete"
    )
      content = (
        <>
          {content}
          <p>
            {plural(cost.fallback_copies, "card")} could not be refreshed now
            and {cost.fallback_copies === "1" ? "shows" : "show"} cached data.
          </p>
        </>
      );
  }
  return (
    <section
      aria-label="Estimated Deck Cost"
      className="deck-cost"
      data-cost-status={status}
    >
      <Heading>Estimated Deck Cost</Heading>
      {content}
      <p>
        Cached TCGplayer market prices (USD) for the exact Editions in this
        Deck. Excludes shipping and taxes.
      </p>
    </section>
  );
}
