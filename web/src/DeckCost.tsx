import { useEffect, useRef, useState } from "react";
import { getDeckCost, PriceError, type DeckCost } from "./prices_generated";

// Estimated Deck Cost and Pricing Coverage come from one server-side access over every copy in the Deck, never from
// the rows this page happens to render. A result belongs to one inventory revision: an answer for another revision is
// discarded, and a newer one asks the page to reload its checks (which re-renders this with the new revision).
const CLIENT_TIMEOUT_MS = 3_500;

type Settled =
  { kind: "cost"; cost: DeckCost } | { kind: "unavailable" } | null;

const plural = (count: string, word: string) =>
  `${count} ${word}${count === "1" ? "" : "s"}`;

export function DeckCostSummary({
  deckId,
  ownerRevision,
  totalCopies,
  onNewerRevision,
}: {
  deckId: string;
  ownerRevision: number;
  totalCopies: string;
  onNewerRevision: () => void;
}) {
  const [settled, setSettled] = useState<Settled>(null);
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
        // An older revision is simply dropped: the request for the current one is already on its way.
      })
      .catch((cause) => {
        if (!live) return;
        if (cause instanceof PriceError && cause.status === 404) return;
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
      <h4>Estimated Deck Cost</h4>
      {content}
      <p>
        Cached TCGplayer market prices (USD) for the exact Editions in this
        Deck. Excludes shipping and taxes.
      </p>
    </section>
  );
}
