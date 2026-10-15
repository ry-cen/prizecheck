import type React from "react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  BrowseEdition,
  BrowseFormat,
  BrowseKind,
} from "../catalog_browse_generated";
import {
  closeSpellings,
  FORMAT_NAMES,
  FORMATS,
  KINDS,
} from "../catalog/catalogText";
import { useCatalogBrowse } from "../catalog/useCatalogBrowse";
import { EditionPrice } from "../EditionPrice";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { EditionTile } from "../ui/EditionTile";
import { SearchField } from "../ui/SearchField";
import { Segmented } from "../ui/Segmented";
import { variantLabel } from "../ui/variantLabel";
import { TILE_PRICE } from "../workspace/Gallery";
import { useDebouncedValue } from "../workspace/useDebouncedValue";
import { LibraryCardPopup } from "./LibraryCardPopup";
import type { DeckDragPayload } from "./useDeckDrag";
import type { EditFeedback } from "./useDeckListEdits";

const SEARCH_DELAY_MS = 250;
// The next page loads while the end of the library is still this far below its scroll box.
const SCROLL_AHEAD = "0px 0px 600px 0px";

type Shown = "owned" | "all";
const SHOWN = [
  { value: "owned", label: "Owned" },
  { value: "all", label: "All" },
] as const;

type Props = {
  deckId: string;
  /** The id of the column's heading ("Library"). */
  headingId: string;
  /** The Deck's Target Format: the format chip starts on it (#178's seam). */
  targetFormat: BrowseFormat;
  /** Desktop: the column sits beside the Deck List and scrolls on its own. */
  ownScroll: boolean;
  /** Copies of an Edition on the Deck List, edits on their way included. */
  quantityOf: (editionId: string) => bigint;
  /** The card popup's −1 or +1 on one library card. */
  onChange: (row: BrowseEdition, delta: bigint) => void;
  feedback: EditFeedback | null;
  /** A press on a tile that may become a drag onto the Deck List (desktop, mouse or pen). */
  onDragStart: (
    payload: DeckDragPayload,
    event: React.PointerEvent<HTMLElement>
  ) => void;
  /** The drop target's look while a copy is dragged here from the Deck List. */
  dropClass: string;
};

/**
 * The deck builder's library (#177, spec "Deck builder": library): Card Editions from the browse route with the
 * Deck's id, each tile showing copies free (owned, not in this Deck) of copies owned, and its price. Owned / All
 * starts on Owned, and an unowned Edition is darkened. A search box, format chips (Any, Standard, Expanded, GLC,
 * starting on the Deck's Target Format; a chip hides only cards that aren't legal, and an unknown one shows "?")
 * and type chips narrow it. The list scrolls on, page after page.
 *
 * Dragging a tile onto the Deck List adds one copy; tapping it opens the card popup with −1 / N on Deck List / +1.
 * The column is also where a copy dragged off the Deck List is dropped. Deck List edits never change a tile: free
 * and owned count physical copies, which a Deck List edit doesn't move.
 */
export function DeckLibrary({
  deckId,
  headingId,
  targetFormat,
  ownScroll,
  quantityOf,
  onChange,
  feedback,
  onDragStart,
  dropClass,
}: Props) {
  const [text, setText] = useState("");
  const q = useDebouncedValue(text.trim(), SEARCH_DELAY_MS);
  const [shown, setShown] = useState<Shown>("owned");
  const [format, setFormat] = useState<BrowseFormat | null>(targetFormat);
  const [kind, setKind] = useState<BrowseKind | null>(null);
  const query = useMemo(
    () => ({ q, format, kind, owned: shown === "owned", deck_id: deckId }),
    [q, format, kind, shown, deckId]
  );
  const browse = useCatalogBrowse(query, true);
  const rows = browse.editions;
  const [open, setOpen] = useState<{ editionId: string; since: number } | null>(
    null
  );
  const opener = useRef<HTMLElement | null>(null);
  const scroller = useRef<HTMLElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const countId = useId();
  const closeId = useId();
  const { loadMore } = browse;
  const canLoad = browse.nextCursor !== null && !browse.errorMore;
  const index = open
    ? rows.findIndex((row) => row.edition_id === open.editionId)
    : -1;
  const row = index >= 0 ? rows[index] : null;

  const stepTo = useCallback(
    (target: number) => {
      const next = rows[target];
      if (next)
        setOpen(
          (current) => current && { ...current, editionId: next.edition_id }
        );
    },
    [rows]
  );
  const onPrevious = useCallback(() => stepTo(index - 1), [stepTo, index]);
  const onNext = useCallback(() => stepTo(index + 1), [stepTo, index]);

  // Stepping near the end of the loaded tiles asks for the next page ahead of time.
  useEffect(() => {
    if (open && index >= 0 && index >= rows.length - 5 && canLoad) loadMore();
  }, [open, index, rows.length, canLoad, loadMore]);
  // A new query can drop the open card: close the popup rather than show another.
  useEffect(() => {
    if (open && index < 0 && !browse.loading) setOpen(null);
  }, [open, index, browse.loading]);

  // Scrolling on: a sentinel after the last tile asks for the next page as it nears the column's (or, on a phone,
  // the window's) bottom edge.
  useEffect(() => {
    const element = sentinel.current;
    if (!element || !canLoad || typeof IntersectionObserver === "undefined")
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { root: ownScroll ? scroller.current : null, rootMargin: SCROLL_AHEAD }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [canLoad, ownScroll, rows.length, browse.loadingMore, loadMore]);

  const first = browse.first;
  // A close-spelling search says so above the count, and the search box reads it first.
  const close = first?.search.mode === "fuzzy" ? first.search.text : null;
  return (
    <aside
      ref={scroller}
      aria-labelledby={headingId}
      data-deck-drop="library"
      className={`box-border flex min-w-0 flex-col gap-3 self-start rounded-panel border border-border bg-surface p-4 ${
        ownScroll
          ? "sticky top-[calc(var(--space-4)+var(--layout-sticky-top))] max-h-[calc(100dvh-var(--space-8)-var(--layout-sticky-top))] overflow-y-auto overscroll-contain"
          : "w-full"
      }${dropClass}`}
    >
      <h2 id={headingId} className="m-0 text-heading font-semibold">
        Library
      </h2>
      <SearchField
        label="Search the library"
        placeholder="Card name, or set code and number"
        value={text}
        maxLength={120}
        aria-describedby={close === null ? countId : `${closeId} ${countId}`}
        onChange={(event) => setText(event.target.value)}
      />
      {/* A scroll container (Segmented) has no automatic minimum height, so keep it from shrinking in the Library column. */}
      <div className="shrink-0">
        <Segmented
          mode="choice"
          label="Library cards"
          options={SHOWN}
          value={shown}
          onChange={setShown}
        />
      </div>
      {/* Formats, then card types, each on its own row: the panel is too narrow for one row, and a divider would
          land at the end or the start of a wrapped line. */}
      <div
        role="group"
        aria-label="Library filters"
        className="flex min-w-0 flex-col gap-1.5"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Chip selected={format === null} onChange={() => setFormat(null)}>
            Any format
          </Chip>
          {FORMATS.map((option) => (
            <Chip
              key={option.value}
              selected={format === option.value}
              onChange={(on) => setFormat(on ? option.value : null)}
            >
              {option.label}
            </Chip>
          ))}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {KINDS.map((option) => (
            <Chip
              key={option.value}
              selected={kind === option.value}
              onChange={(on) => setKind(on ? option.value : null)}
            >
              {option.label}
            </Chip>
          ))}
        </div>
      </div>
      <div role="status" className="flex flex-col gap-0.5 text-meta">
        {browse.notice && (
          <p className="m-0 font-medium text-text">{browse.notice}</p>
        )}
        {close !== null && (
          <p id={closeId} className="m-0 text-text-muted">
            {closeSpellings(close)}
          </p>
        )}
        <p id={countId} className="m-0 text-text-subtle">
          {first && !first.available
            ? "The catalog is unavailable until its first import."
            : !first
              ? browse.loading
                ? "Loading the library…"
                : ""
              : rows.length === 0
                ? shown === "owned" && !q && !format && !kind
                  ? "You don't own any cards yet. Choose All to plan cards you don't own."
                  : "No cards match."
                : `Showing ${rows.length.toLocaleString()} of ${(first.matches ?? rows.length).toLocaleString()} cards`}
        </p>
      </div>
      {browse.error && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 text-body text-danger"
        >
          <p className="m-0">{browse.error}</p>
          <Button onClick={browse.retry}>Retry</Button>
        </div>
      )}
      {rows.length > 0 && (
        <ul
          aria-label="Library results"
          aria-busy={browse.loading}
          className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(var(--tile-small),1fr))] gap-x-(--tile-gap-column) gap-y-(--tile-gap-row) p-0"
        >
          {rows.map((edition, position) => (
            <li
              key={edition.edition_id}
              className="min-w-0"
              // A keyboard path past the loaded rows: focus reaching the last tile loads the next page.
              onFocus={
                position === rows.length - 1 && canLoad ? loadMore : undefined
              }
            >
              <LibraryTile
                edition={edition}
                format={format}
                onDragStart={onDragStart}
                onOpen={(element) => {
                  opener.current = element;
                  setOpen({
                    editionId: edition.edition_id,
                    since: feedback?.id ?? 0,
                  });
                }}
              />
            </li>
          ))}
        </ul>
      )}
      {canLoad && <div ref={sentinel} aria-hidden="true" className="h-px" />}
      <p aria-live="polite" className="m-0 text-meta text-text-subtle">
        {browse.loadingMore ? "Loading more cards…" : ""}
      </p>
      <LibraryCardPopup
        row={row}
        onClose={() => setOpen(null)}
        position={
          index >= 0 && first?.matches != null
            ? { index, total: Math.max(first.matches, rows.length) }
            : null
        }
        canPrevious={index > 0}
        canNext={index >= 0 && index < rows.length - 1}
        onPrevious={onPrevious}
        onNext={onNext}
        quantity={row ? quantityOf(row.edition_id) : 0n}
        onChange={(delta) => row && onChange(row, delta)}
        feedback={feedback}
        since={open?.since ?? 0}
        returnFocus={opener}
      />
    </aside>
  );
}

/** One library tile: an EditionTile with copies free of owned, its price and, under a format chip, a "?" for
 * an unknown standing. */
function LibraryTile({
  edition,
  format,
  onOpen,
  onDragStart,
}: {
  edition: BrowseEdition;
  format: BrowseFormat | null;
  onOpen: (element: HTMLElement) => void;
  onDragStart: Props["onDragStart"];
}) {
  const priceId = useId();
  const unknown = format && edition.standing[format].status === "unknown";
  const free = edition.free ?? edition.owned;
  return (
    <EditionTile
      name={edition.name}
      setName={edition.set_name}
      setCode={edition.set_code}
      collectorNumber={edition.collector_number}
      variant={variantLabel(edition.descriptor)}
      imageUrl={edition.image_url}
      owned={edition.owned}
      badge={`${free}/${edition.owned}`}
      ownedText={
        edition.owned > 0
          ? `${free} free of ${edition.owned} owned`
          : "not owned"
      }
      flag={
        unknown
          ? { text: "?", label: `${FORMAT_NAMES[format]} legality unknown` }
          : null
      }
      price={
        <span className={TILE_PRICE}>
          <EditionPrice editionId={edition.edition_id} />
        </span>
      }
      priceId={priceId}
      aria-describedby={priceId}
      data-edition-id={edition.edition_id}
      onPointerDown={(event) =>
        onDragStart(
          {
            from: "library",
            editionId: edition.edition_id,
            name: edition.name,
          },
          event
        )
      }
      onClick={(event) => onOpen(event.currentTarget)}
    />
  );
}
