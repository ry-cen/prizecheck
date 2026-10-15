import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { DeckCostFigures } from "../prices_generated";
import type { WantList } from "../want_list_generated";
import {
  getWantListCost,
  type WantListCost,
} from "../want_list_cost_generated";

// The Want List's cost (decklist import #210): one price access per Want List answer (GET /api/want-list/cost, ADR 0006),
// read after the page has drawn. It is shown only for the answer it names: the same scope, counting, settings and
// inventory revisions and Deck Lists digest. An answer for another state asks the page to read the Want List again,
// once; the cost of that new answer follows.
const CLIENT_TIMEOUT_MS = 3_500;

export type CostLoad =
  | { kind: "checking" }
  | { kind: "ready"; cost: WantListCost }
  | { kind: "unavailable" };

const CHECKING: CostLoad = { kind: "checking" };

/** Whether a cost answer belongs to the Want List answer on the page. */
function answers(cost: WantListCost, list: WantList): boolean {
  return (
    cost.deck_id === list.deck_id &&
    cost.want_list_counting === list.want_list_counting &&
    cost.settings_revision === list.settings_revision &&
    cost.owner_revision === list.owner_revision &&
    cost.deck_lists_digest === list.deck_lists_digest
  );
}

/**
 * Reads the cost of `list` once per Want List answer. `onChanged` reads the Want List again when the cost was captured
 * at another state; if the next cost doesn't match either, the cost is unavailable rather than asked for again.
 */
export function useWantListCost(
  list: WantList | null,
  onChanged: () => void
): CostLoad {
  const [state, setState] = useState<{ list: WantList; load: CostLoad }>();
  const reread = useRef(false);
  useEffect(() => {
    if (!list) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
    let live = true;
    const settle = (load: CostLoad) => {
      if (live) setState({ list, load });
    };
    getWantListCost(list.deck_id, controller.signal)
      .then((cost) => {
        // Nothing was captured (an exhausted budget or a failed capture): the total says so, with no figures.
        if (cost.owner_revision === null || answers(cost, list)) {
          reread.current = false;
          settle({ kind: "ready", cost });
        } else if (!reread.current) {
          reread.current = true;
          if (live) onChanged();
        } else settle({ kind: "unavailable" });
      })
      .catch(() => settle({ kind: "unavailable" }))
      .finally(() => clearTimeout(timer));
    return () => {
      live = false;
      clearTimeout(timer);
      controller.abort();
    };
    // onChanged is a fresh closure on every render; only a new Want List answer starts a new access.
  }, [list]);
  // A cost read for an earlier answer is never shown against a later one.
  return state && list && state.list === list ? state.load : CHECKING;
}

/** The page's cost, for the pieces inside the Want List view. */
export const WantListCostContext = createContext<CostLoad>(CHECKING);

const plural = (count: string, word: string) =>
  `${count} ${word}${count === "1" ? "" : "s"}`;

function unpricedOf(figure: DeckCostFigures): string {
  return (
    BigInt(figure.total_copies ?? "0") - BigInt(figure.priced_copies ?? "0")
  ).toString();
}

/**
 * One figure as a line, a section or a combined row reads it: "$0.50", "$0.75 + 1 unpriced" when some copies have no
 * price (never counted as $0), "No price" when none has, "Price unavailable" when the prices couldn't be read in time.
 */
export function costText(figure: DeckCostFigures): string {
  switch (figure.status) {
    case "priced": {
      const unpriced = unpricedOf(figure);
      return unpriced === "0"
        ? figure.display_amount!
        : `${figure.display_amount} + ${unpriced} unpriced`;
    }
    case "empty":
      return figure.display_amount ?? "$0.00";
    case "no_quotes":
      return "No price";
    default:
      return "Price unavailable";
  }
}

function useReady(): WantListCost | null {
  const load = useContext(WantListCostContext);
  return load.kind === "ready" ? load.cost : null;
}

/** A section's cost beside "N cards to get"; nothing for a Deck that needs nothing, or before the cost arrives. */
export function SectionCost({ deckId }: { deckId: string }) {
  const cost = useReady();
  const figure = cost?.sections.find(
    (section) => section.deck_id === deckId
  )?.cost;
  if (!figure || figure.status === "empty") return null;
  return (
    <span className="text-meta tabular-nums text-text-muted">
      {costText(figure)}
    </span>
  );
}

/**
 * A line's cost and its price each, under its "N of M" ("$0.50 · $0.25 each"), or "No price". It sits in the line's
 * right-hand column on a desktop and below the line on a phone.
 */
export function LineCost({
  deckId,
  editionId,
}: {
  deckId: string;
  editionId: string;
}) {
  const cost = useReady();
  const line = cost?.sections
    .find((section) => section.deck_id === deckId)
    ?.lines.find((item) => item.edition_id === editionId);
  if (!line) return null;
  const parts = [costText(line.cost)];
  if (line.price_each) parts.push(`${line.price_each} each`);
  if (line.cost.stale_copies && line.cost.stale_copies !== "0")
    parts.push("stale (price over 48 hours old)");
  return (
    <p className="col-start-2 m-0 text-right text-meta tabular-nums text-text-muted wrap-anywhere phone:col-start-1 phone:text-left">
      {parts.join(" · ")}
    </p>
  );
}

/** A combined row's cost. */
export function RowCost({ editionId }: { editionId: string }) {
  const cost = useReady();
  const row = cost?.combined.find((item) => item.edition_id === editionId);
  if (!row) return null;
  return (
    <span className="shrink-0 text-meta tabular-nums text-text-muted">
      {costText(row.cost)}
    </span>
  );
}

/** " · $19.30" (or " · $19.30 + 2 unpriced") for the combined total's title, once its cost is priced. */
export function useTotalCostSuffix(): string {
  const cost = useReady();
  return cost && cost.total.status === "priced"
    ? ` · ${costText(cost.total)}`
    : "";
}

/**
 * The summary's estimated cost and how many cards are priced (spec "The Want List page"). Unpriced cards are reported
 * on their own line and never counted as $0; stale, unknown-age and cached-fallback counts are named when there are any.
 */
export function CostSummary() {
  const load = useContext(WantListCostContext);
  let value = "Checking prices…";
  const notes: string[] = [];
  if (load.kind === "unavailable") {
    value = "Price unavailable";
    notes.push("Coverage unavailable");
  } else if (load.kind === "ready") {
    const total = load.cost.total;
    const copies = total.total_copies ?? "0";
    if (total.status === "empty") {
      value = total.display_amount ?? "$0.00";
      notes.push("Nothing to buy");
    } else if (total.status === "no_quotes") {
      value = "Price unavailable";
      notes.push(`0/${copies} cards priced`);
    } else if (total.status === "priced") {
      value = total.display_amount!;
      notes.push(`${total.priced_copies}/${copies} cards priced`);
      const unpriced = unpricedOf(total);
      if (unpriced !== "0")
        notes.push(`${plural(unpriced, "card")} without a price, not counted`);
      if (total.stale_copies && total.stale_copies !== "0")
        notes.push(
          `${plural(total.stale_copies, "stale card")} (price over 48 hours old)`
        );
      if (total.unknown_age_copies && total.unknown_age_copies !== "0")
        notes.push(
          `${plural(total.unknown_age_copies, "card")} with unknown price age`
        );
      if (total.fallback_copies && total.fallback_copies !== "0")
        notes.push(
          `${plural(total.fallback_copies, "card")} could not be refreshed now and ${total.fallback_copies === "1" ? "shows" : "show"} cached data`
        );
    } else {
      value = "Price unavailable";
      notes.push("Coverage unavailable");
    }
  }
  return (
    <p className="m-0 flex flex-col" aria-live="polite">
      <span className="text-meta text-text-muted">Estimated cost</span>
      <span className="text-display font-semibold tabular-nums">{value}</span>
      {notes.map((note) => (
        <span key={note} className="text-meta tabular-nums text-text-muted">
          {note}
        </span>
      ))}
    </p>
  );
}
