import React, { useEffect, useState } from "react";
import { getEditionDistribution } from "../collection_generated";
import { EditionPrice } from "../EditionPrice";
import type { HoldingView } from "../holdings_generated";
import { metadataReportHref } from "../metadataReportLink";
import { Dialog } from "../ui/Dialog";
import { variantLabel } from "../ui/variantLabel";
import { CATEGORY_OPTIONS, plural } from "./galleryModel";
import type { Inspected } from "./useSelection";
import "./Inspector.css";

/** Hover and selection change quickly; wait this long before asking for an Edition's copies or price. */
const TOTAL_DELAY_MS = 150;
const PRICE_DELAY_MS = TOTAL_DELAY_MS;

/** One Storage Leaf (or Deck) holding copies of the inspected Edition. */
export type LeafCopies = {
  locationId: string;
  locationName: string;
  quantity: number;
};

type DetailsProps = {
  card: Inspected;
  /** Full path such as "Shelf / Binder 2", or undefined when the tree doesn't know the Location. */
  locationPath: (id: string) => string | undefined;
  /** The gallery listing's owner revision; a new revision re-reads the copies owned. */
  ownerRevision: number | null;
  /** Each Edition's Leaves already read ("<revision>:<edition>"), kept by the Workspace so they outlive
   * the details panel's mounts. */
  ownedTotals: Map<string, LeafCopies[]>;
  /** The phone sheet: the Dialog's title already names the card, and the art is narrower. */
  sheet?: boolean;
};

/** Category and elemental type, for example "Pokémon · Fire" or "Pokémon · Psychic · Water".
 * The Holding listing returns them as `category` and `elemental_types` (ticket 104); the line is
 * omitted when the catalog knows neither. */
export function cardKindLine(holding: HoldingView): string | null {
  const { category, elemental_types } = holding as HoldingView & {
    category?: string | null;
    elemental_types?: readonly string[] | null;
  };
  const label =
    CATEGORY_OPTIONS.find((option) => option.value === category)?.label ??
    category;
  const parts = [label, ...(elemental_types ?? [])].filter(
    (part): part is string => !!part
  );
  return parts.length ? parts.join(" · ") : null;
}

type Owned =
  | { state: "loading" }
  | { state: "ready"; leaves: LeafCopies[] }
  | { state: "failed" };

/** Where the Edition's copies are, across every Location: the per-Edition distribution read (one row per
 * Holding, Decks included). The gallery may show one Location only, so this read is separate. Rows are
 * cached per owner revision in the Workspace's map; with no owner revision yet, nothing is read from or
 * written to the cache. */
function useOwnedCopies(
  editionId: string,
  ownerRevision: number | null,
  cache: Map<string, LeafCopies[]>
): Owned {
  const key = `${ownerRevision ?? ""}:${editionId}`;
  const cached = ownerRevision === null ? undefined : cache.get(key);
  const [owned, setOwned] = useState<{ key: string; value: Owned }>({
    key: "",
    value: { state: "loading" },
  });
  useEffect(() => {
    if (ownerRevision !== null && cache.has(key)) return;
    setOwned({ key, value: { state: "loading" } });
    let live = true;
    const timer = window.setTimeout(() => {
      getEditionDistribution(editionId)
        .then((distribution) => {
          const leaves = distribution.holdings.map((holding) => ({
            locationId: holding.location_id,
            locationName: holding.location_name,
            quantity: Number(holding.quantity) || 0,
          }));
          if (ownerRevision !== null) cache.set(key, leaves);
          if (live) setOwned({ key, value: { state: "ready", leaves } });
        })
        .catch(() => {
          if (live) setOwned({ key, value: { state: "failed" } });
        });
    }, TOTAL_DELAY_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [key, editionId, ownerRevision, cache]);
  if (cached !== undefined) return { state: "ready", leaves: cached };
  return owned.key === key ? owned.value : { state: "loading" };
}

/** Location paths in the order the tree lists them: natural, case-insensitive ("Binder 2" before
 * "Binder 10"). */
const byPath = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});
const counts = new Intl.NumberFormat("en-US");

// Inside the workspace, Workspace.css's `.ws-root h2, .ws-root p { margin: 0 }` is unlayered and beats
// margin utilities, so the details use padding for their spacing. The price section is inset by
// px-1 and the panel ends with pb-1 so the report link's focus ring isn't clipped by the panel's scroll box.
const META = "text-meta text-text-muted tabular-nums";
const SECTION = "mt-4 border-t border-border pt-4";

/** The inspected card's facts: set, number and Variant, category and type, its Location, copies there,
 * copies owned and each Storage Leaf that holds them (#164), then its price. */
export function CardDetails({
  card,
  locationPath,
  ownerRevision,
  ownedTotals,
  sheet = false,
}: DetailsProps) {
  const { holding } = card.holding;
  const owned = useOwnedCopies(holding.edition_id, ownerRevision, ownedTotals);
  const kind = cardKindLine(holding);
  const copiesOwned =
    owned.state === "ready"
      ? owned.leaves.reduce((sum, leaf) => sum + leaf.quantity, 0)
      : 0;
  const leaves =
    owned.state === "ready"
      ? owned.leaves
          .map((leaf) => ({
            ...leaf,
            path: locationPath(leaf.locationId) ?? leaf.locationName,
          }))
          .sort(
            (a, b) =>
              byPath.compare(a.path, b.path) ||
              a.locationId.localeCompare(b.locationId)
          )
      : [];
  return (
    <div className="text-body">
      <DetailsArt holding={holding} narrow={sheet} />
      {!sheet && (
        <h2 className="pt-4 text-heading font-[550] wrap-anywhere">
          {holding.printing_name}
        </h2>
      )}
      <p className={`${sheet ? "pt-4" : "pt-1"} ${META}`}>
        {holding.set_name} · {holding.collector_number}
      </p>
      <dl className="m-0 flex gap-2 pt-1 text-meta text-text-muted">
        <dt className="text-text-subtle">Variant</dt>
        <dd className="m-0 min-w-0 wrap-anywhere">
          {variantLabel(holding.descriptor)}
        </dd>
      </dl>
      {kind && <p className={`pt-1 ${META}`}>{kind}</p>}
      <div className={`${SECTION} text-meta wrap-anywhere`}>
        <p>{locationPath(holding.location_id) ?? holding.location_name}</p>
        <p className="pt-1 text-text-subtle tabular-nums">
          {plural(card.holding.copies, "copy", "copies")} here
        </p>
        <p className="pt-1 text-text-subtle tabular-nums">
          {owned.state === "ready"
            ? `${plural(copiesOwned, "copy", "copies")} owned`
            : owned.state === "failed"
              ? "Copies owned unavailable"
              : "Counting copies owned…"}
        </p>
        {leaves.length > 0 && (
          <ul
            aria-label="Copies by location"
            className="m-0 flex list-none flex-col gap-0.5 p-0 pt-1 tabular-nums"
          >
            {leaves.map((leaf) => (
              <li key={leaf.locationId} className="text-text-muted">
                <span className="font-semibold text-text">
                  {counts.format(leaf.quantity)}
                </span>{" "}
                in {leaf.path}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div
        className={`ws-details-price ${SECTION} flex flex-col items-start gap-2 px-1 text-meta tabular-nums wrap-anywhere`}
      >
        <InspectorPrice
          key={holding.edition_id}
          editionId={holding.edition_id}
        />
        <a
          className="inline-flex min-h-(--target-pointer) items-center text-accent underline-offset-2 hover:text-accent-strong phone:min-h-tap"
          href={metadataReportHref(holding.printing_id, holding.edition_id)}
        >
          Report a problem with this card's data
        </a>
      </div>
    </div>
  );
}

/** The inspected Card Edition's price through the existing EditionPrice component (full labels: age, stale,
 * unavailable, refresh). Hover moves quickly, so the price is asked for only once the same Edition has stayed
 * inspected for PRICE_DELAY_MS; until then the slot shows the component's own checking label. */
function InspectorPrice({ editionId }: { editionId: string }) {
  const [settledId, setSettledId] = useState<string | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(
      () => setSettledId(editionId),
      PRICE_DELAY_MS
    );
    return () => window.clearTimeout(timer);
  }, [editionId]);
  if (settledId === editionId) return <EditionPrice editionId={editionId} />;
  return (
    <span className="edition-price" data-price-status="checking">
      Checking prices…
    </span>
  );
}

function DetailsArt({
  holding,
  narrow,
}: {
  holding: HoldingView;
  narrow: boolean;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [holding.image_url]);
  return (
    <span
      className={`block aspect-(--tile-aspect) overflow-hidden rounded-card bg-[linear-gradient(135deg,var(--color-art-start),var(--color-art-end))] shadow-[0_var(--space-1)_var(--space-3)_var(--color-shadow)] ${narrow ? "mx-auto w-1/2" : "w-full"}`}
      aria-hidden="true"
    >
      {holding.image_url && !failed ? (
        <img
          src={holding.image_url}
          alt=""
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
          className="block size-full object-cover"
        />
      ) : (
        <span className="box-border flex h-full items-center justify-center p-3 text-center font-semibold text-text-muted wrap-anywhere">
          {holding.printing_name}
        </span>
      )}
    </span>
  );
}

type InspectorProps = Omit<DetailsProps, "card" | "sheet"> & {
  card: Inspected | null;
};

/** The desktop inspector column. Its space is reserved; it is empty while nothing is hovered or selected.
 * It stays in view while the gallery scrolls, below the app shell's sticky header; when its content is
 * taller than the window (an Edition in many Leaves), it scrolls inside itself so nothing is cut off. */
export function Inspector({ card, ...rest }: InspectorProps) {
  return (
    <aside
      className="sticky top-[calc(var(--space-4)+var(--layout-sticky-top))] mt-6 box-border max-h-[calc(100dvh-var(--space-4)-var(--layout-sticky-top))] min-w-0 self-start overflow-y-auto overscroll-contain pb-1 phone:hidden"
      aria-label="Card details"
    >
      {card && <CardDetails card={card} {...rest} />}
    </aside>
  );
}

type SheetProps = Omit<DetailsProps, "sheet"> & { onClose: () => void };

/** The mobile details sheet: the kit Dialog, a bottom sheet on a phone (#164). Escape, Close or a tap on
 * the dimmed page closes it, Tab stays inside, and focus returns to the tile or button that opened it.
 * The card's name is the sheet's title. */
export function DetailsSheet({ onClose, ...rest }: SheetProps) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={rest.card.holding.holding.printing_name}
      closeLabel="Close details"
    >
      <CardDetails sheet {...rest} />
    </Dialog>
  );
}
