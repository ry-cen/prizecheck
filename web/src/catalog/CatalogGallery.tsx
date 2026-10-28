import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Minus, Plus } from "lucide-react";
import type {
  BrowseEdition,
  BrowseFormat,
  BrowseKind,
  CatalogSet,
} from "../catalog_browse_generated";
import { EditionPrice } from "../EditionPrice";
import { Button } from "../ui/Button";
import { EditionTile } from "../ui/EditionTile";
import { Icon } from "../ui/Icon";
import { SearchField } from "../ui/SearchField";
import { variantLabel } from "../ui/variantLabel";
import { TILE_PRICE } from "../workspace/Gallery";
import { useDebouncedValue } from "../workspace/useDebouncedValue";
import { AddBar } from "./AddBar";
import {
  bump,
  EMPTY_QUEUE,
  editionWords,
  hasRoom,
  minus,
  queueItems,
  without,
  type AddQueue,
} from "./addQueue";
import { addCards, type AddCommand } from "./cardActions";
import { CatalogCardPopup, type CardRequest } from "./CatalogCardPopup";
import { CatalogFilters } from "./CatalogFilters";
import {
  batchFailed,
  CATALOG_UNAVAILABLE,
  earlierBatchFinished,
  FORMAT_NAMES,
  MAX_ADD,
  QUEUE_FULL,
  searchHint,
} from "./catalogText";
import { useAddToast, type AddedCards } from "./useAddToast";
import { useCatalogBrowse } from "./useCatalogBrowse";
import { usePlaces, type Place } from "./usePlaces";

const SEARCH_DELAY_MS = 250;
// The next page loads while the end of the gallery is still this far below the window (or the dialog's body).
const SCROLL_AHEAD = "0px 0px 800px 0px";

type Props = {
  /** False while hidden: the Catalog page kept mounted on another tab, or Collection's Add cards closed. */
  active: boolean;
  /** Add mode (#175): the bar, and a quick + on every tile that becomes a −/N/+ stepper. */
  adding: boolean;
  /** Collection's Add cards from a Location: the Location to add to, shown rather than chosen. Null: the bar's
   * picker chooses among the Storage Leaves. */
  fixedTarget: Place | null;
  /** True on the Catalog page, which shows its own Undo toast after a batch add. Collection's Add cards shows
   * Collection's toast instead, from onAdded. */
  undoToast: boolean;
  /** Every batch add from here, from the bar or the card popup, once it succeeded. */
  onAdded?: (added: AddedCards) => void;
  /** Add N cards found its Location gone: the owner reads its Locations again. */
  onTargetGone?: () => void;
  /** Where the bar sticks: under the shell's header on the page, or to the top of a dialog's body. */
  stick: "page" | "dialog";
  /** The box that scrolls the gallery, when it isn't the window (a dialog's body), for infinite scroll. */
  scrollRoot?: RefObject<HTMLElement | null>;
  /** The search box takes focus when the dialog around the gallery opens (Collection's Add cards). */
  autoFocusSearch?: boolean;
  /** A card to open at once (the inspector's metadata report link). onLinkOpened clears it. */
  link?: CardRequest | null;
  onLinkOpened?: () => void;
  /** A metadata report was sent from the popup. */
  onReported?: () => void;
};

/**
 * Catalog's Edition gallery (#173), its card popup (#174) and its Add mode (#175), for the Catalog page and for
 * Collection's Add cards. One smart search box, one filter row, the catalog's status line, and EditionTiles from the
 * browse route that scroll on: the next page loads as the end nears, or when focus reaches the last tile. Tapping a
 * tile opens the CardPopup, which steps through the loaded tiles, and closing it returns focus to the tile of the card
 * it shows.
 *
 * In Add mode a bar sticks to the top (Adding to [Location], the queued cards, Clear and Add N cards) and every tile
 * gets a + that becomes a −/N/+ stepper; queued tiles are outlined. The queue survives new searches, filters and
 * restarts of the walk, and Add N cards sends it as one batch add with one Undo record. The popup's Add row starts on
 * the target Location whenever the popup opens in Add mode.
 */
export function CatalogGallery({
  active,
  adding,
  fixedTarget,
  undoToast,
  onAdded,
  onTargetGone,
  stick,
  scrollRoot,
  autoFocusSearch = false,
  link,
  onLinkOpened,
  onReported,
}: Props) {
  const [text, setText] = useState("");
  const q = useDebouncedValue(text.trim(), SEARCH_DELAY_MS);
  const [format, setFormat] = useState<BrowseFormat | null>(null);
  const [kind, setKind] = useState<BrowseKind | null>(null);
  const [set, setSet] = useState<CatalogSet | null>(null);
  const [owned, setOwned] = useState(false);
  const query = useMemo(
    () => ({ q, format, kind, set_id: set?.set_id ?? null, owned }),
    [q, format, kind, set, owned]
  );
  const tiles = useRef<HTMLUListElement>(null);
  const browse = useCatalogBrowse(query, active, tiles);
  const { loadMore, noteAdded } = browse;
  const [card, setCard] = useState<CardRequest | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  // The popup's place among the loaded tiles, found by Edition: the list can be replaced under it (a restart).
  const index = card?.editionId
    ? browse.editions.findIndex(
        (edition) => edition.edition_id === card.editionId
      )
    : -1;
  const [wantsNext, setWantsNext] = useState(false);
  const closedOn = useRef<string | null>(null);
  const hintId = useId();
  const sentinel = useRef<HTMLDivElement>(null);
  const canLoad = browse.nextCursor !== null && !browse.errorMore;
  const editionsShown = browse.editions;

  // Add mode: where the copies go, the queue, and the last Add N cards.
  const places = usePlaces(active && adding && !fixedTarget);
  const [chosen, setChosen] = useState<string | null>(null);
  // The bar's choice while it still exists, else Unsorted (the Location every collector has), else the first.
  const picked =
    places.leaves.find((leaf) => leaf.id === chosen) ??
    places.leaves.find((leaf) => leaf.label === "Unsorted") ??
    places.leaves[0] ??
    null;
  const target = fixedTarget ?? picked;
  const [queue, setQueue] = useState<AddQueue>(EMPTY_QUEUE);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [failure, setFailure] = useState("");
  const pendingAdd = useRef<AddCommand | null>(null);
  // What the last Add found: an earlier add that may have completed was settled (#196), or "".
  const [settled, setSettled] = useState("");
  // The popup's adds that may have completed, one per Edition, kept while the popup is closed or stepped away.
  const popupPending = useRef(
    new Map<string, { current: AddCommand | null }>()
  );
  const pendingFor = useCallback((editionId: string) => {
    let slot = popupPending.current.get(editionId);
    if (!slot) {
      slot = { current: null };
      popupPending.current.set(editionId, slot);
    }
    return slot;
  }, []);
  // The popup's Location: the last one chosen in it, reset to the target when the popup opens in Add mode.
  const [popupLocation, setPopupLocation] = useState<string | null>(null);

  const addToast = useAddToast({
    shown: active && undoToast,
    onUndone: (added, ownerRevision) =>
      noteAdded(
        added.items.map((item) => ({
          editionId: item.editionId,
          added: -item.quantity,
        })),
        ownerRevision
      ),
  });
  const live = useRef({ undoToast, onAdded, addToast });
  live.current = { undoToast, onAdded, addToast };
  const added = useCallback(
    (result: AddedCards) => {
      noteAdded(
        result.items.map((item) => ({
          editionId: item.editionId,
          added: item.quantity,
        })),
        result.ownerRevision
      );
      if (live.current.undoToast) void live.current.addToast(result);
      live.current.onAdded?.(result);
    },
    [noteAdded]
  );

  const show = useCallback((edition: BrowseEdition) => {
    setCard({
      printingId: edition.printing_id,
      editionId: edition.edition_id,
      row: edition,
      report: null,
    });
  }, []);
  const stepTo = useCallback(
    (position: number) => {
      const edition = editionsShown[position];
      if (edition) show(edition);
    },
    [editionsShown, show]
  );
  const onPrevious = useCallback(() => stepTo(index - 1), [stepTo, index]);
  const onNext = useCallback(() => {
    if (index < editionsShown.length - 1) stepTo(index + 1);
    else if (canLoad) {
      // At the last loaded tile: step once the next page arrives.
      setWantsNext(true);
      loadMore();
    }
  }, [stepTo, index, editionsShown.length, canLoad, loadMore]);

  // Stepping near the end of the loaded tiles asks for the next page ahead of time.
  useEffect(() => {
    if (card && index >= 0 && index >= editionsShown.length - 5 && canLoad)
      loadMore();
  }, [card, index, editionsShown.length, canLoad, loadMore]);
  // The page asked for by › at the end arrived (or failed): step, or stop waiting.
  useEffect(() => {
    if (!wantsNext) return;
    if (!card || index < 0 || browse.errorMore) setWantsNext(false);
    else if (index < editionsShown.length - 1) {
      setWantsNext(false);
      stepTo(index + 1);
    }
  }, [wantsNext, card, index, editionsShown.length, browse.errorMore, stepTo]);
  // Closing the popup after stepping returns focus to the tile of the card it showed (the Dialog itself returns it
  // to the tile that opened it); the browser scrolls that tile into view.
  useEffect(() => {
    if (card || !closedOn.current) return;
    const id = closedOn.current;
    closedOn.current = null;
    const tile = tiles.current?.querySelector<HTMLElement>(
      `[data-edition-id="${CSS.escape(id)}"] button`
    );
    if (tile && tile !== document.activeElement) tile.focus();
  }, [card]);

  // Infinite scroll: a sentinel after the last tile asks for the next page as it nears the window (or the dialog's
  // body). Observing again after each page (the length changes) asks once more while the sentinel is still in reach.
  useEffect(() => {
    const element = sentinel.current;
    if (
      !element ||
      !canLoad ||
      !active ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { root: scrollRoot?.current ?? null, rootMargin: SCROLL_AHEAD }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [
    canLoad,
    active,
    browse.editions.length,
    browse.loadingMore,
    loadMore,
    scrollRoot,
  ]);

  // A card asked for from outside (the inspector's report link) opens at once.
  useEffect(() => {
    if (!link) return;
    opener.current = null;
    setCard(link);
    onLinkOpened?.();
  }, [link, onLinkOpened]);

  function queueChange(edition: BrowseEdition, by: 1 | -1) {
    if (busyRef.current) return;
    setFailure("");
    setSettled("");
    setQueue((current) => bump(current, edition, by));
  }

  async function addAll() {
    if (busyRef.current || !target || queue.size === 0) return;
    busyRef.current = true;
    setBusy(true);
    setFailure("");
    setSettled("");
    const items = queueItems(queue);
    const outcome = await addCards(target.id, target.label, items, pendingAdd);
    busyRef.current = false;
    setBusy(false);
    if (outcome.ok) {
      // A batch that may have completed earlier is settled first (#196): only its copies leave the queue, and the rest
      // stay for the collector to review before the next press.
      if (outcome.settledEarlier) {
        const left = minus(queue, outcome.items);
        setQueue(left);
        setSettled(
          earlierBatchFinished(outcome.copies, outcome.path, left.size > 0)
        );
      } else setQueue(EMPTY_QUEUE);
      added({
        locationId: outcome.locationId,
        path: outcome.path,
        items: outcome.items,
        copies: outcome.copies,
        ownerRevision: outcome.ownerRevision,
        undoId: outcome.undoId,
        from: "bar",
      });
      return;
    }
    const refused = outcome.editionId
      ? queue.get(outcome.editionId)?.edition
      : undefined;
    setFailure(
      batchFailed(
        outcome.code,
        outcome.retry,
        refused ? editionWords(refused) : null
      )
    );
    // A card no longer available can't be added: it leaves the queue, so the rest can go.
    if (outcome.code === "EDITION_UNAVAILABLE" && outcome.editionId)
      setQueue((current) => without(current, outcome.editionId!));
    if (outcome.code === "LOCATION_NOT_FOUND") {
      places.reload();
      onTargetGone?.();
    }
  }

  const first = browse.first;
  const unavailable = first !== null && !first.available;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {adding && (
        <AddBar
          fixed={fixedTarget}
          options={places.leaves}
          targetId={picked?.id ?? null}
          onTarget={setChosen}
          optionsText={
            places.state === "failed"
              ? "Locations unavailable"
              : places.state === "ready"
                ? "No Storage Leaves yet"
                : "Loading Locations…"
          }
          queue={queue}
          ready={target !== null}
          busy={busy}
          failure={failure}
          settled={settled}
          note={hasRoom(queue) ? "" : QUEUE_FULL}
          onClear={() => {
            setFailure("");
            setSettled("");
            setQueue(EMPTY_QUEUE);
          }}
          onAdd={() => void addAll()}
          stick={stick}
        />
      )}
      <div className="flex min-w-0 flex-col gap-1.5">
        <SearchField
          label="Search the catalog"
          placeholder="Card name, or set code and number"
          value={text}
          maxLength={120}
          aria-describedby={hintId}
          data-autofocus={autoFocusSearch ? "" : undefined}
          onChange={(event) => setText(event.target.value)}
        />
        <p id={hintId} className="m-0 text-meta text-text-muted">
          {searchHint(first?.search ?? null)}
        </p>
      </div>
      <CatalogFilters
        format={format}
        onFormat={setFormat}
        kind={kind}
        onKind={setKind}
        set={set}
        onSet={setSet}
        owned={owned}
        onOwned={setOwned}
      />
      <div role="status" className="flex flex-col gap-0.5 text-meta">
        {browse.notice && (
          <p className="m-0 font-medium text-text">{browse.notice}</p>
        )}
        <p className="m-0 text-text-muted">
          {/* No Printing count here: the results line under it already says how many cards match. */}
          {unavailable
            ? CATALOG_UNAVAILABLE
            : !first && browse.loading
              ? "Loading the catalog…"
              : ""}
        </p>
      </div>
      {browse.error && !browse.errorMore && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 text-body text-danger"
        >
          <p className="m-0">{browse.error}</p>
          <Button onClick={browse.retry}>Retry</Button>
        </div>
      )}
      {first?.available && (
        <section aria-label="Catalog results" className="flex flex-col gap-3">
          <p className="m-0 text-meta text-text-subtle">
            {browse.editions.length === 0
              ? "No cards match this search."
              : `Showing ${browse.editions.length.toLocaleString()} of ${(first.matches ?? browse.editions.length).toLocaleString()} cards`}
          </p>
          {browse.editions.length > 0 && (
            <ul
              ref={tiles}
              aria-busy={browse.loading || browse.loadingMore}
              className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(var(--tile-medium),1fr))] gap-x-(--tile-gap-column) gap-y-(--tile-gap-row) p-0"
            >
              {browse.editions.map((edition, index) => {
                const count = adding
                  ? (queue.get(edition.edition_id)?.count ?? 0)
                  : 0;
                return (
                  <li
                    key={edition.edition_id}
                    data-edition-id={edition.edition_id}
                    className="relative min-w-0"
                    // A keyboard path past the loaded rows: focus reaching the last tile loads the next page.
                    onFocus={
                      index === browse.editions.length - 1 && canLoad
                        ? loadMore
                        : undefined
                    }
                  >
                    <CatalogTile
                      edition={edition}
                      format={format}
                      queued={count}
                      onOpen={(element) => {
                        opener.current = element;
                        if (adding && target) setPopupLocation(target.id);
                        show(edition);
                      }}
                    />
                    {adding && (
                      <QuickAdd
                        words={editionWords(edition)}
                        count={count}
                        canAdd={count > 0 ? count < MAX_ADD : hasRoom(queue)}
                        onChange={(by) => queueChange(edition, by)}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {canLoad && (
            <div ref={sentinel} aria-hidden="true" className="h-px" />
          )}
          {browse.error && browse.errorMore && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-3 text-body text-danger"
            >
              <p className="m-0">{browse.error}</p>
              <Button onClick={browse.retry}>Retry</Button>
            </div>
          )}
          {/* The list is marked busy while a page loads; only the end of the list is announced. */}
          <p className="m-0 text-meta text-text-subtle empty:hidden">
            {browse.loadingMore ? "Loading more cards…" : ""}
          </p>
          {/* Always in the page, so a screen reader is watching it before its text arrives. */}
          <p aria-live="polite" className="m-0 text-meta text-text-subtle">
            {!browse.loadingMore &&
            !browse.loading &&
            browse.editions.length > 0 &&
            browse.nextCursor === null
              ? `All ${browse.editions.length.toLocaleString()} cards shown`
              : ""}
          </p>
        </section>
      )}
      <CatalogCardPopup
        request={card}
        onClose={() => {
          closedOn.current = card?.editionId ?? null;
          setWantsNext(false);
          setCard(null);
        }}
        position={
          index >= 0 && first?.matches != null
            ? { index, total: Math.max(first.matches, editionsShown.length) }
            : null
        }
        canPrevious={index > 0}
        canNext={
          index >= 0 &&
          !wantsNext &&
          (index < editionsShown.length - 1 || canLoad)
        }
        onPrevious={onPrevious}
        onNext={onNext}
        pendingFor={pendingFor}
        location={popupLocation}
        onLocation={setPopupLocation}
        alsoOffer={adding ? target : null}
        onAdded={added}
        onReported={onReported ?? (() => {})}
        returnFocus={opener}
      />
    </div>
  );
}

/** One gallery tile: an EditionTile with its price and, under a format chip, a "?" for an unknown standing. */
function CatalogTile({
  edition,
  format,
  queued,
  onOpen,
}: {
  edition: BrowseEdition;
  format: BrowseFormat | null;
  queued: number;
  onOpen: (element: HTMLElement) => void;
}) {
  const priceId = useId();
  const unknown = format && edition.standing[format].status === "unknown";
  return (
    <EditionTile
      name={edition.name}
      setName={edition.set_name}
      setCode={edition.set_code}
      collectorNumber={edition.collector_number}
      variant={variantLabel(edition.descriptor)}
      imageUrl={edition.image_url}
      owned={edition.owned}
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
      queued={queued}
      aria-describedby={priceId}
      onClick={(event) => onOpen(event.currentTarget)}
    />
  );
}

// 26 px on desktop; 36 px on a phone, where a square pseudo-element widens the tap area to 44 px (a rounded one would
// leave its corners out of the tap area).
const QUICK =
  "relative m-0 box-border inline-flex size-quick shrink-0 cursor-pointer items-center justify-center rounded-round border-0 p-0 font-sans disabled:cursor-default disabled:opacity-45 phone:size-quick-phone phone:before:absolute phone:before:-inset-1";

/**
 * A tile's quick add (#175): a + over the art's lower right corner that becomes − N + once the card is queued. It is
 * the tile's sibling, not inside its button, so the tile stays one control.
 */
function QuickAdd({
  words,
  count,
  canAdd,
  onChange,
}: {
  /** The card in a few words, for the buttons' names: "Bulbasaur MEG 001 Reverse Holo". */
  words: string;
  count: number;
  canAdd: boolean;
  onChange: (by: 1 | -1) => void;
}) {
  return (
    <div
      role="group"
      aria-label={`${words}: ${count} to add`}
      className="absolute right-1.5 bottom-[calc(var(--tile-names-height)+var(--tile-price-height)+var(--space-1))] flex items-center gap-1 rounded-round border border-border-strong bg-surface-raised p-0.5 phone:gap-2"
    >
      {count > 0 && (
        <>
          <button
            type="button"
            aria-label={`One fewer ${words}`}
            onClick={() => onChange(-1)}
            className={`${QUICK} bg-transparent text-text hover:bg-surface-selected`}
          >
            <Icon icon={Minus} />
          </button>
          <span
            aria-hidden="true"
            className="min-w-4 text-center text-control font-semibold tabular-nums"
          >
            {count}
          </span>
        </>
      )}
      <button
        type="button"
        aria-label={`One more ${words}`}
        disabled={!canAdd}
        onClick={() => onChange(1)}
        className={`${QUICK} bg-accent text-on-accent enabled:hover:bg-accent-strong`}
      >
        <Icon icon={Plus} />
      </button>
    </div>
  );
}
