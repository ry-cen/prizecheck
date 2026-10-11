import React, { useEffect, useId, useRef, useState } from "react";
import { getEditionDistribution } from "../collection_generated";
import type { HoldingView } from "../holdings_generated";
import { plural } from "./galleryModel";
import type { Inspected } from "./useSelection";
import "./Inspector.css";

const FOCUSABLE =
  'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Hover and selection change quickly; wait this long before asking for an Edition's total. */
const TOTAL_DELAY_MS = 150;

type DetailsProps = {
  card: Inspected;
  /** Full path such as "Shelf / Binder 2", or undefined when the tree doesn't know the Location. */
  locationPath: (id: string) => string | undefined;
  /** The gallery listing's owner revision; a new revision re-reads totals. */
  ownerRevision: number | null;
  headingId?: string;
};

/** Category and elemental type, for example "Pokémon · Fire". Ticket 104 stores both on the Card
 * Printing and returns them on the Holding listing as `category` and `elemental_types`; until then
 * this is null and the line is omitted. If ticket 104 names them differently, change only this function. */
export function cardKindLine(holding: HoldingView): string | null {
  const { category, elemental_types } = holding as HoldingView & {
    category?: string | null;
    elemental_types?: readonly string[] | null;
  };
  const parts = [category, ...(elemental_types ?? [])].filter(
    (part): part is string => !!part
  );
  return parts.length ? parts.join(" · ") : null;
}

type Total =
  | { state: "loading" }
  | { state: "ready"; copies: number }
  | { state: "failed" };

/** Copies of an Edition owned across every Location. The gallery may show one Location only, so
 * this reads the Edition's distribution. Totals are cached per owner revision. */
function useOwnedTotal(editionId: string, ownerRevision: number | null): Total {
  const cache = useRef(new Map<string, number>());
  const key = `${ownerRevision ?? ""}:${editionId}`;
  const [total, setTotal] = useState<{ key: string; value: Total }>({
    key: "",
    value: { state: "loading" },
  });
  useEffect(() => {
    const cached = cache.current.get(key);
    if (cached !== undefined) {
      setTotal({ key, value: { state: "ready", copies: cached } });
      return;
    }
    setTotal({ key, value: { state: "loading" } });
    let live = true;
    const timer = window.setTimeout(() => {
      getEditionDistribution(editionId)
        .then((distribution) => {
          const copies = distribution.holdings.reduce(
            (sum, holding) => sum + (Number(holding.quantity) || 0),
            0
          );
          cache.current.set(key, copies);
          if (live) setTotal({ key, value: { state: "ready", copies } });
        })
        .catch(() => {
          if (live) setTotal({ key, value: { state: "failed" } });
        });
    }, TOTAL_DELAY_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [key, editionId]);
  return total.key === key ? total.value : { state: "loading" };
}

/** The inspected card's facts: set, number, category and type, Location path, copies there and total owned. */
export function CardDetails({
  card,
  locationPath,
  ownerRevision,
  headingId,
}: DetailsProps) {
  const { holding } = card.holding;
  const total = useOwnedTotal(holding.edition_id, ownerRevision);
  const kind = cardKindLine(holding);
  return (
    <div className="ws-details">
      <DetailsArt holding={holding} />
      <h2 id={headingId} className="ws-details-name">
        {holding.printing_name}
      </h2>
      <p className="ws-details-meta">
        {holding.set_name} · {holding.collector_number}
      </p>
      {kind && <p className="ws-details-meta">{kind}</p>}
      <div className="ws-details-location">
        <p className="ws-details-path">
          {locationPath(holding.location_id) ?? holding.location_name}
        </p>
        <p className="ws-details-counts">
          {plural(card.holding.copies, "copy", "copies")} here
        </p>
        <p className="ws-details-counts">
          {total.state === "ready"
            ? `${plural(total.copies, "copy", "copies")} owned`
            : total.state === "failed"
              ? "Copies owned unavailable"
              : "Counting copies owned…"}
        </p>
      </div>
      {/* Ticket 111 adds the inspected Edition's price and the metadata report link here. */}
    </div>
  );
}

function DetailsArt({ holding }: { holding: HoldingView }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [holding.image_url]);
  return (
    <span className="ws-details-art" aria-hidden="true">
      {holding.image_url && !failed ? (
        <img
          src={holding.image_url}
          alt=""
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="ws-details-fallback">{holding.printing_name}</span>
      )}
    </span>
  );
}

type InspectorProps = Omit<DetailsProps, "card" | "headingId"> & {
  card: Inspected | null;
};

/** The desktop inspector column. Its space is reserved; it is empty while nothing is hovered or selected. */
export function Inspector({ card, ...rest }: InspectorProps) {
  return (
    <aside className="ws-inspector ws-desktop-only" aria-label="Card details">
      {card && <CardDetails card={card} {...rest} />}
    </aside>
  );
}

type SheetProps = Omit<DetailsProps, "headingId"> & { onClose: () => void };

/** The mobile details sheet: a modal dialog from the bottom. Escape or Close closes it, Tab stays
 * inside, and focus returns to the tile that opened it. */
export function DetailsSheet({ onClose, ...rest }: SheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusables = () =>
      Array.from(
        sheetRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []
      );
    focusables()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const inside = sheetRef.current?.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !inside)
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = overflow;
      if (opener?.isConnected && opener.getClientRects().length) opener.focus();
    };
  }, []);
  return (
    <div className="ws-sheet-backdrop" onClick={onClose}>
      <div
        ref={sheetRef}
        className="ws-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="ws-sheet-heading">
          <button
            type="button"
            className="ws-header-icon"
            aria-label="Close details"
            onClick={onClose}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        <CardDetails headingId={headingId} {...rest} />
      </div>
    </div>
  );
}
