import { useEffect, useId, useState } from "react";
import {
  browseEditions,
  type BrowseEdition,
} from "../catalog_browse_generated";
import { EditionPrice } from "../EditionPrice";
import { Button } from "../ui/Button";
import { variantLabel } from "../ui/variantLabel";
import { TILE_PRICE } from "../workspace/Gallery";
import { ownedWords } from "./LibraryCardPopup";

type Found =
  | { state: "loading" }
  | { state: "failed" }
  | {
      state: "ready";
      rows: BrowseEdition[];
      next: string | null;
      more: boolean;
    };

const BOX =
  "box-border m-0 flex min-h-control w-full flex-col items-start gap-0.5 rounded-control border border-solid bg-surface-raised px-2 py-1 text-left font-sans text-meta text-text phone:min-h-tap";
const ROW = `${BOX} cursor-pointer border-border-strong enabled:hover:border-control-outline`;
const CURRENT_ROW = `${BOX} border-control-outline`;

/**
 * "Swap this copy for" in the copy sheet (#177): every other active Edition of the line's Card Identity, from the
 * browse route (identity_id, with the Deck's id for copies free of owned), newest set first. Choosing one swaps one
 * copy in one batch, so one Undo puts it back. A Card Identity can have hundreds of Editions (Basic Energy), so
 * the list reads 60 at a time, with Show more.
 */
export function SwapList({
  deckId,
  identityId,
  editionId,
  currentName,
  currentEdition,
  onSwap,
}: {
  deckId: string;
  identityId: string;
  /** The copy's own Edition: shown first in the list, marked Current, and not offered as a swap. */
  editionId: string;
  /** The copy's card name and "Set · number · Variant" words, for the Current row (the Edition may be on a later page). */
  currentName: string;
  currentEdition: string;
  onSwap: (row: BrowseEdition) => void;
}) {
  const headingId = useId();
  const [found, setFound] = useState<Found>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setFound({ state: "loading" });
    browseEditions({ identity_id: identityId, deck_id: deckId })
      .then((page) => {
        if (live)
          setFound({
            state: "ready",
            rows: page.editions,
            next: page.next_cursor,
            more: false,
          });
      })
      .catch(() => {
        if (live) setFound({ state: "failed" });
      });
    return () => {
      live = false;
    };
  }, [deckId, identityId, attempt]);

  async function showMore() {
    if (found.state !== "ready" || !found.next || found.more) return;
    setFound({ ...found, more: true });
    try {
      const page = await browseEditions(
        { identity_id: identityId, deck_id: deckId },
        found.next
      );
      setFound({
        state: "ready",
        rows: [...found.rows, ...page.editions],
        next: page.next_cursor,
        more: false,
      });
    } catch {
      // A moved collection or catalog (409) or a failure: read the list again from the start.
      setAttempt((value) => value + 1);
    }
  }

  const loadedCurrent =
    found.state === "ready"
      ? found.rows.find((row) => row.edition_id === editionId)
      : undefined;
  const others =
    found.state === "ready"
      ? found.rows.filter((row) => row.edition_id !== editionId)
      : [];
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="m-0 text-meta font-semibold">
        Swap this copy for
      </h3>
      {found.state === "loading" ? (
        <p role="status" className="m-0 text-meta text-text-muted">
          Loading other Editions…
        </p>
      ) : found.state === "failed" ? (
        <div role="alert" className="flex flex-wrap items-center gap-2">
          <p className="m-0 text-meta text-danger">
            Other Editions are unavailable.
          </p>
          <Button onClick={() => setAttempt((value) => value + 1)}>
            Retry
          </Button>
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          <CurrentRow
            editionId={editionId}
            name={currentName}
            edition={currentEdition}
            owned={loadedCurrent ? ownedWords(loadedCurrent) : null}
          />
          {others.length === 0 && (
            <li className="text-meta text-text-muted">
              This card has no other Edition.
            </li>
          )}
          {others.map((row) => (
            <SwapRow key={row.edition_id} row={row} onSwap={onSwap} />
          ))}
        </ul>
      )}
      {found.state === "ready" && found.next && (
        <Button
          className="self-start"
          aria-disabled={found.more || undefined}
          onClick={() => void showMore()}
        >
          Show more Editions
        </Button>
      )}
    </section>
  );
}

/**
 * The copy's own Edition, pinned at the top of the list whichever page it falls on (so Show more never adds it
 * again or loses it). It is marked Current and has no button: swapping a copy for its own Edition changes nothing.
 */
function CurrentRow({
  editionId,
  name,
  edition,
  owned,
}: {
  editionId: string;
  name: string;
  edition: string;
  owned: string | null;
}) {
  return (
    <li aria-current="true" className={CURRENT_ROW}>
      <span className="font-semibold">
        {name} <span className="font-normal text-text-muted">· Current</span>
      </span>
      <span className="text-text-muted tabular-nums">
        {edition}
        {owned ? ` · ${owned}` : ""}
      </span>
      <span className={`${TILE_PRICE} max-w-full tabular-nums`}>
        <EditionPrice editionId={editionId} />
      </span>
    </li>
  );
}

/** One Edition to swap to: its name, set, number and Variant, copies free of owned, and its price. */
function SwapRow({
  row,
  onSwap,
}: {
  row: BrowseEdition;
  onSwap: (row: BrowseEdition) => void;
}) {
  const priceId = useId();
  const edition = `${row.set_name} · ${row.collector_number} · ${variantLabel(row.descriptor)}`;
  return (
    <li>
      <button
        type="button"
        className={ROW}
        aria-label={`${row.name}, ${edition}, ${ownedWords(row)}`}
        aria-describedby={priceId}
        onClick={() => onSwap(row)}
      >
        <span className="font-semibold">{row.name}</span>
        <span className="text-text-muted tabular-nums">
          {edition} · {ownedWords(row)}
        </span>
        <span id={priceId} className={`${TILE_PRICE} max-w-full tabular-nums`}>
          <EditionPrice editionId={row.edition_id} />
        </span>
      </button>
    </li>
  );
}
