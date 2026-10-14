import { useCallback, useEffect, useRef, useState } from "react";
import {
  browseEditions,
  type BrowseEdition,
  type BrowsePage,
} from "../catalog_browse_generated";
import { getEditionDistribution } from "../collection_generated";
import { getPrinting, type PrintingView } from "../generated";
import type { HoldingView } from "../holdings_generated";

/** One Card Edition of the open Printing, as the popup's Edition picker shows it. */
export type PopupEdition = {
  id: string;
  descriptor: Record<string, unknown>;
  /** False for a retired ("unavailable") Edition: it has no tile, no price and can't be added. */
  active: boolean;
  /** Owner reviewed (a manual Edition), with its evidence. */
  reviewed: boolean;
  evidenceUrl: string | null;
  /** Copies the collector owns, or null while unknown. */
  owned: number | null;
};

export type CardDetails =
  | { state: "loading" }
  | { state: "failed" }
  | {
      state: "ready";
      printing: PrintingView;
      /** The Printing's browse rows (one per active Edition): standing, regulation mark, set code and copies. Empty
       * when every Edition is retired. */
      rows: BrowseEdition[];
      editions: PopupEdition[];
      /** The browse read: still on its way, answered, or failed (then rows are empty and active Editions' copies are
       * null). The popup never waits on it. */
      browse: "pending" | "ok" | "missing";
    };

export type CopiesWhere =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "ready"; holdings: HoldingView[] };

/**
 * The open card's details: the Printing detail (GET /api/catalog/printings/{id}: Card Identity, source, evidence and
 * every Edition, retired ones included) and the browse route for that Printing (#174's printing_id: each active
 * Edition's copies, the regulation mark and the Format Standing). A retired Edition's copies come from the
 * per-Edition collection read. `reload` reads them again after an Add.
 */
export function useCardDetails(printingId: string | null): {
  details: CardDetails;
  reload: () => void;
} {
  // Each answer remembers its Printing, so another card shows loading at once while a reload of the same card
  // (after an Add) keeps the current answer on screen until the new one arrives.
  const [answer, setAnswer] = useState<{
    printingId: string;
    value: CardDetails;
  } | null>(null);
  const latest = useRef<typeof answer>(null);
  latest.current = answer;
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!printingId) return;
    let live = true;
    const setDetails = (value: CardDetails) => {
      if (live) setAnswer({ printingId, value });
    };
    // The browse read only adds facts: it never blocks or fails the popup (a standings rebuild can make it wait).
    const browse = browseEditions({ printing_id: printingId }).then(
      (page) => page,
      () => null
    );
    const previous =
      latest.current?.printingId === printingId &&
      latest.current.value.state === "ready";
    getPrinting(printingId)
      .then(async (detail) => {
        const printing = detail.printing;
        const retired = printing.editions.filter((edition) => !edition.active);
        const retiredCopies = await Promise.all(
          retired.map((edition) =>
            getEditionDistribution(edition.id)
              .then((found) =>
                found.holdings.reduce(
                  (sum, holding) => sum + (Number(holding.quantity) || 0),
                  0
                )
              )
              .catch(() => null)
          )
        );
        const retiredOwned = new Map(
          retired.map((edition, index) => [edition.id, retiredCopies[index]])
        );
        const build = (
          page: BrowsePage | null,
          state: "pending" | "ok" | "missing"
        ): CardDetails => {
          const rows = new Map(
            (page?.editions ?? []).map((row) => [row.edition_id, row])
          );
          return {
            state: "ready",
            printing,
            rows: page?.editions ?? [],
            browse: state,
            // Available Editions first, in the Printing's Variant order, then the retired ones.
            editions: [
              ...printing.editions.filter((edition) => edition.active),
              ...retired,
            ].map((edition) => ({
              id: edition.id,
              descriptor: edition.descriptor,
              active: edition.active,
              reviewed: edition.source === "manual",
              evidenceUrl: edition.evidence_url ?? null,
              owned: edition.active
                ? page
                  ? (rows.get(edition.id)?.owned ?? 0)
                  : null
                : (retiredOwned.get(edition.id) ?? null),
            })),
          };
        };
        // Show the card as soon as the Printing is read, unless a reload keeps the current answer meanwhile.
        if (!previous) setDetails(build(null, "pending"));
        const page = await browse;
        if (page) setDetails(build(page, "ok"));
        else if (!previous) setDetails(build(null, "missing"));
      })
      // A failed reload of the card on screen keeps what it shows.
      .catch(() => {
        if (!previous) setDetails({ state: "failed" });
      });
    return () => {
      live = false;
    };
  }, [printingId, generation]);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  return {
    details:
      answer && answer.printingId === printingId
        ? answer.value
        : { state: "loading" },
    reload,
  };
}

/** Where the collector's copies of one Card Edition are: the existing per-Edition collection read (spec "Catalog
 * browse route"), one row per Holding, Decks included. `version` reads it again after an Add. */
export function useCopiesWhere(
  editionId: string | null,
  version: number
): CopiesWhere {
  const [where, setWhere] = useState<{ key: string; value: CopiesWhere }>({
    key: "",
    value: { state: "loading" },
  });
  const key = `${editionId ?? ""}:${version}`;
  useEffect(() => {
    if (!editionId) return;
    let live = true;
    getEditionDistribution(editionId)
      .then((found) => {
        if (live)
          setWhere({
            key,
            value: { state: "ready", holdings: found.holdings },
          });
      })
      .catch(() => {
        if (live) setWhere({ key, value: { state: "failed" } });
      });
    return () => {
      live = false;
    };
  }, [editionId, key]);
  if (where.key === key) return where.value;
  // A reload after an Add keeps the previous answer for the same Edition until the new one arrives.
  if (where.key.startsWith(`${editionId ?? ""}:`)) return where.value;
  return { state: "loading" };
}
