import type { CatalogView } from "./catalogUrl";
import { getCatalogSets } from "../catalog_browse_generated";
import { useStoredAddQueue } from "./useStoredAddQueue";
import { useFirstReadSettled } from "../shell/keptRead";
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
import { useToast, useShownToastId } from "../ui/Toast";
import { Button } from "../ui/Button";
import { EditionTile } from "../ui/EditionTile";
import { Icon } from "../ui/Icon";
import { SearchField } from "../ui/SearchField";
import { variantLabel } from "../ui/variantLabel";
import { TILE_PRICE } from "../workspace/Gallery";
import { useDebouncedValue } from "../workspace/useDebouncedValue";
import { AddBar } from "./AddBar";
import { bump, editionWords, hasRoom, queueItems } from "./addQueue";
import { addCards, type AddCommand } from "./cardActions";
import { CatalogCardPopup, type CardRequest } from "./CatalogCardPopup";
import { CatalogFilters } from "./CatalogFilters";
import {
  ADD_UNKNOWN,
  batchFailed,
  BROWSE_FAILED,
  batchAddedText,
  CATALOG_UNAVAILABLE,
  earlierBatchFinished,
  FORMAT_NAMES,
  MAX_ADD,
  QUEUE_FULL,
  searchHint,
} from "./catalogText";
import { useAddToast, type AddedCards, type InlineUndo } from "./useAddToast";
import { useCatalogBrowse } from "./useCatalogBrowse";
import { usePlaces, type Place } from "./usePlaces";

const SEARCH_DELAY_MS = 250;
// The next page loads while the end of the gallery is still this far below the window (or the dialog's body).
const SCROLL_AHEAD = "0px 0px 800px 0px";

type Props = {
  /** False while hidden: the Catalog page kept mounted on another tab, or Collection's Add cards closed. */
  active: boolean;
  view?: CatalogView;
  onViewChange?: (view: CatalogView) => void;
  /** Add mode (#175): the bar, and a quick + on every tile that becomes a −/N/+ stepper. */
  adding: boolean;
  /** Collection's Add cards from a Location: the Location to add to, shown rather than chosen. Null: the bar's
   * picker chooses among the Storage Leaves. */
  fixedTarget: Place | null;
  /** True on the Catalog page, which shows its own Undo toast after a batch add. Collection's Add cards shows
   * Collection's toast instead, from onAdded. */
  undoToast: boolean;
  /** Every batch add from here, from the bar or the card popup, once it succeeded. */
  onAdded?: (added: AddedCards) => void | Promise<InlineUndo | null>;
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
  view,
  onViewChange,
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
  const [localText, setLocalText] = useState("");
  const [localFormat, setLocalFormat] = useState<BrowseFormat | null>(null);
  const [localKind, setLocalKind] = useState<BrowseKind | null>(null);
  const [set, storeSet] = useState<CatalogSet | null>(null);
  const [resolvedSet, setResolvedSet] = useState<{
    id: string;
    found: CatalogSet | null;
  } | null>(null);
  const [failedSet, setFailedSet] = useState<string | null>(null);
  const [setAttempt, retrySet] = useState(0);
  const [localOwned, setLocalOwned] = useState(false);
  const text = view?.q ?? localText;
  const format = view ? view.format : localFormat;
  const kind = view ? view.kind : localKind;
  const owned = view?.owned ?? localOwned;
  const setId = view ? view.setId : (set?.set_id ?? null);
  const setText = (q: string) =>
    view && onViewChange ? onViewChange({ ...view, q }) : setLocalText(q);
  const setFormat = (format: BrowseFormat | null) =>
    view && onViewChange
      ? onViewChange({ ...view, format })
      : setLocalFormat(format);
  const setKind = (kind: BrowseKind | null) =>
    view && onViewChange ? onViewChange({ ...view, kind }) : setLocalKind(kind);
  const setOwned = (owned: boolean) =>
    view && onViewChange
      ? onViewChange({ ...view, owned })
      : setLocalOwned(owned);
  const setSet = (set: CatalogSet | null) => {
    storeSet(set);
    if (view && set) setResolvedSet({ id: set.set_id, found: set });
    if (view && onViewChange)
      onViewChange({ ...view, setId: set?.set_id ?? null });
  };
  const setResolved = !view || !setId || resolvedSet?.id === setId;
  const browseSetId =
    view && setId
      ? resolvedSet?.id === setId
        ? (resolvedSet.found?.set_id ?? null)
        : null
      : setId;
  const viewOwner = useRef({ view, onViewChange });
  viewOwner.current = { view, onViewChange };
  useEffect(() => {
    if (!view) return;
    if (!setId) {
      storeSet(null);
      return;
    }
    let live = true;
    setFailedSet(null);
    void getCatalogSets()
      .then((list) => {
        if (!live) return;
        if (!list.available) {
          setFailedSet(setId);
          return;
        }
        const found = list.sets.find((set) => set.set_id === setId) ?? null;
        storeSet(found);
        setResolvedSet({ id: setId!, found });
      })
      .catch(() => {
        if (live) setFailedSet(setId);
      });
    return () => {
      live = false;
    };
  }, [setId, !!view, setAttempt]);
  // A validation may finish while the kept page is hidden. Keep its result and
  // replay URL normalisation on activation instead of discarding it there.
  useEffect(() => {
    const current = viewOwner.current;
    if (
      active &&
      setId &&
      resolvedSet?.id === setId &&
      !resolvedSet.found &&
      current.view?.setId === setId
    )
      current.onViewChange?.({ ...current.view, setId: null });
  }, [active, setId, resolvedSet, view]);
  const q = useDebouncedValue(text.trim(), SEARCH_DELAY_MS);
  const query = useMemo(
    () => ({ q, format, kind, set_id: browseSetId, owned }),
    [q, format, kind, browseSetId, owned]
  );
  const tiles = useRef<HTMLUListElement>(null);
  const browse = useCatalogBrowse(query, active, tiles, setResolved);
  const { loadMore, noteAdded } = browse;
  const setLookupFailed = !setResolved && failedSet === setId;
  const searchError = setLookupFailed ? BROWSE_FAILED : browse.error;
  const retrySearch = setLookupFailed
    ? () => retrySet((attempt) => attempt + 1)
    : browse.retry;
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
  // AddCardsGallery mounts this gallery for each opening. Capture that opening's destination:
  // a later fallback to the picker keeps its queue, while opening another Location gets its own.
  const [queueScope] = useState(() =>
    stick === "dialog" ? `dialog:${fixedTarget?.id ?? "picker"}` : "page"
  );
  const stored = useStoredAddQueue(queueScope);
  const queueToast = useToast();
  const clearToast = useRef<number | null>(null);
  const restoreFocus = useRef(false);
  const clearedUndo = useRef<(() => boolean) | null>(null);
  const [clearInline, setClearInline] = useState<{
    undo: () => boolean;
  } | null>(null);
  useEffect(() => {
    if (clearToast.current !== null) {
      queueToast.dismiss(clearToast.current);
      clearToast.current = null;
    }
    const undoClear = clearedUndo.current;
    clearedUndo.current = null;
    setClearInline(null);
    if (undoClear && stick === "dialog") setClearInline({ undo: undoClear });
    else if (undoClear)
      clearToast.current = queueToast.show({
        message: "Queue cleared.",
        focus: true,
        action: {
          label: "Undo",
          onAction: () => {
            if (undoClear()) restoreFocus.current = true;
          },
        },
      });
    if (restoreFocus.current) {
      restoreFocus.current = false;
      const root = galleryRoot.current;
      (
        root?.querySelector<HTMLButtonElement>(
          "[data-queue-add]:not(:disabled)"
        ) ?? root?.querySelector<HTMLInputElement>('input[type="search"]')
      )?.focus();
    }
  }, [stored.queue, stored.chosen, active, queueToast, stick]);
  useEffect(() => {
    if (clearInline)
      galleryRoot.current
        ?.querySelector<HTMLButtonElement>("[data-clear-undo]")
        ?.focus();
  }, [clearInline]);
  useEffect(
    () => () => {
      if (clearToast.current !== null) queueToast.dismiss(clearToast.current);
    },
    [queueToast]
  );
  const { queue, setQueue, chosen, setChosen } = stored;
  // Keep an uncertain command at its original Location, even if that Location is gone.
  // Otherwise use the chosen Location, Unsorted, or the first available leaf.
  const picked =
    places.leaves.find((leaf) => leaf.id === chosen) ??
    (stored.pending.current && chosen === stored.pending.current.locationId
      ? {
          id: stored.pending.current.locationId,
          label: stored.pending.current.path,
        }
      : null) ??
    places.leaves.find((leaf) => leaf.label === "Unsorted") ??
    places.leaves[0] ??
    null;
  const target = fixedTarget ?? picked;
  // Closing the tab still loses its sessionStorage, so keep the browser warning.
  const queued = queue.size > 0;
  useEffect(() => {
    if (!queued) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [queued]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [failure, setFailure] = useState("");
  const pendingAdd = stored.pending;
  // What the last Add found: an earlier add that may have completed was settled (#196), or "".
  const [settledAdd, setSettledAdd] = useState<{
    copies: number | string;
    path: string;
  } | null>(null);
  const settled = settledAdd
    ? earlierBatchFinished(settledAdd.copies, settledAdd.path, queue.size > 0)
    : "";
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
  // Collection's feedback belongs to the gallery, rather than the AddRows that unmounts on close/step.
  const [feedback, setFeedback] = useState<{
    message: string;
    undo: InlineUndo | null;
  } | null>(null);
  const [undoing, setUndoing] = useState(false);
  const feedbackBusy = useRef(false);
  const feedbackVersion = useRef(0);
  const galleryRoot = useRef<HTMLDivElement>(null);
  const feedbackEffects = useRef({
    onUndone: () => {},
    focusAfterUndo: () => {},
  });
  useShownToastId();

  function renderAddFeedback(
    onUndone: () => void,
    focusAfterUndo: () => void,
    announce = true
  ) {
    feedbackEffects.current = { onUndone, focusAfterUndo };
    async function pressUndo() {
      if (!feedback?.undo || feedbackBusy.current) return;
      const version = feedbackVersion.current;
      feedbackBusy.current = true;
      setUndoing(true);
      try {
        const result = await feedback.undo();
        if (version !== feedbackVersion.current) return;
        setFeedback({
          message: result.message || feedback.message,
          undo: result.next,
        });
        // Close/step can move the control while this request is in flight: refresh and focus the current view.
        if (result.undone) feedbackEffects.current.onUndone();
        if (!result.next) feedbackEffects.current.focusAfterUndo();
      } finally {
        feedbackBusy.current = false;
        setUndoing(false);
      }
    }
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p
          role={announce ? "status" : undefined}
          className="m-0 min-w-0 flex-1 text-meta text-text"
        >
          {feedback?.message ?? ""}
        </p>
        {feedback?.undo?.isAvailable() && (
          <Button
            aria-disabled={undoing || undefined}
            onClick={() => void pressUndo()}
          >
            Undo
          </Button>
        )}
      </div>
    );
  }
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
      const version = ++feedbackVersion.current;
      const external = live.current.onAdded?.(result);
      const undo = live.current.undoToast
        ? live.current.addToast(result)
        : Promise.resolve(external ?? null).then((undo) =>
            undo
              ? observeUndo(undo, (ownerRevision) =>
                  noteAdded(
                    result.items.map((item) => ({
                      editionId: item.editionId,
                      added: -item.quantity,
                    })),
                    ownerRevision
                  )
                )
              : null
          );
      if (!live.current.undoToast) {
        setFeedback(null);
        void undo.then((offered) => {
          if (version === feedbackVersion.current)
            setFeedback({
              message: batchAddedText(result.copies, result.path),
              undo: offered,
            });
        });
      }
      return undo;
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

  // An earlier add's notice belongs to the Location it was for.
  const targetId = target?.id;
  useEffect(() => {
    setSettledAdd(null);
  }, [targetId]);

  function queueChange(edition: BrowseEdition, by: 1 | -1) {
    if (busyRef.current || !stored.ready) return;
    setFailure("");
    setSettledAdd(null);
    if (target) setChosen(target.id);
    setQueue((current) => bump(current, edition, by));
  }

  async function addAll() {
    if (
      busyRef.current ||
      !stored.ready ||
      stored.blocked ||
      !target ||
      queue.size === 0
    )
      return;
    busyRef.current = true;
    setBusy(true);
    setFailure("");
    setSettledAdd(null);
    const items = queueItems(queue);
    const outcome = await addCards(
      target.id,
      target.label,
      items,
      pendingAdd,
      stored.submitting
    );
    stored.settle(outcome);
    busyRef.current = false;
    setBusy(false);
    if (outcome.ok) {
      // A batch that may have completed earlier is settled first (#196): only its copies leave the queue, and the rest
      // stay for the collector to review before the next press.
      if (outcome.settledEarlier) {
        setSettledAdd({ copies: outcome.copies, path: outcome.path });
      }
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
    if (outcome.code === "LOCATION_NOT_FOUND") {
      places.reload();
      onTargetGone?.();
    }
  }

  useFirstReadSettled(browse.first !== null || !!searchError);
  const first = browse.first;
  const unavailable = first !== null && !first.available;
  return (
    <div ref={galleryRoot} className="flex min-w-0 flex-col gap-4">
      {clearInline && (
        <div role="status" className="flex flex-wrap items-center gap-2">
          <p className="m-0 text-meta">Queue cleared.</p>
          <Button
            data-clear-undo
            onClick={() => {
              if (clearInline.undo()) restoreFocus.current = true;
            }}
          >
            Undo
          </Button>
        </div>
      )}
      {stored.restoreFailed && (
        <div role="alert" className="flex flex-wrap items-center gap-2">
          <p className="m-0 text-meta">{stored.notice}</p>
          <Button onClick={stored.clear}>Discard queue</Button>
        </div>
      )}
      {stored.uncertain && (
        <div role="status" className="flex flex-wrap items-center gap-2">
          <p className="m-0 text-meta">{ADD_UNKNOWN}</p>
          <Button onClick={stored.dismiss}>Dismiss</Button>
        </div>
      )}
      {adding && (
        <AddBar
          fixed={fixedTarget}
          options={
            picked && !places.leaves.some((leaf) => leaf.id === picked.id)
              ? [picked, ...places.leaves]
              : places.leaves
          }
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
          ready={target !== null && stored.ready && !stored.blocked}
          busy={busy}
          failure={
            failure ||
            (stored.blocked
              ? batchFailed("REPLAY_OUTCOME_UNAVAILABLE", false, null)
              : !busy && pendingAdd.current
                ? batchFailed("", true, null)
                : "")
          }
          settled={settled}
          note={
            (!stored.restoreFailed && stored.notice) ||
            (hasRoom(queue) ? "" : QUEUE_FULL)
          }
          onClear={() => {
            setFailure("");
            setSettledAdd(null);
            clearedUndo.current = stored.clearUndo();
            if (!clearedUndo.current)
              galleryRoot.current
                ?.querySelector<HTMLInputElement>('input[type="search"]')
                ?.focus();
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
          {searchHint(
            searchError || browse.loading || text.trim() !== q
              ? null
              : (first?.search ?? null)
          )}
        </p>
      </div>
      <CatalogFilters
        format={format}
        onFormat={setFormat}
        kind={kind}
        onKind={setKind}
        set={
          view ? (resolvedSet?.id === setId ? resolvedSet.found : null) : set
        }
        onSet={setSet}
        owned={owned}
        onOwned={setOwned}
      />
      <div role="status" className="flex flex-col gap-0.5 text-meta">
        {!undoToast &&
          !card &&
          renderAddFeedback(
            () => {},
            () =>
              galleryRoot.current
                ?.querySelector<HTMLInputElement>('input[type="search"]')
                ?.focus(),
            false
          )}
        {browse.notice && (
          <p className="m-0 font-medium text-text">{browse.notice}</p>
        )}
        <p className="m-0 text-text-muted">
          {/* No Printing count here: the results line under it already says how many cards match. */}
          {unavailable
            ? CATALOG_UNAVAILABLE
            : !first && browse.loading && !setLookupFailed
              ? "Loading the catalog…"
              : ""}
        </p>
      </div>
      {searchError && !browse.errorMore && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 text-body text-danger"
        >
          <p className="m-0">{searchError}</p>
          <Button onClick={retrySearch}>Retry</Button>
        </div>
      )}
      {first?.available && (!searchError || browse.errorMore) && (
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
                      adding={adding}
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
        renderAddFeedback={undoToast ? undefined : renderAddFeedback}
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
  adding,
  onOpen,
}: {
  edition: BrowseEdition;
  format: BrowseFormat | null;
  queued: number;
  adding: boolean;
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
      ownedBadgePosition={adding ? "top-right" : "bottom-right"}
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

// Preserve the compact desktop control; phone controls have a full 44 px hit area.
const QUICK =
  "relative m-0 box-border inline-flex size-quick shrink-0 cursor-pointer items-center justify-center rounded-round border-0 p-0 font-sans disabled:cursor-default disabled:opacity-45 phone:size-11";

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

/** Collection owns the toast, but this embedded gallery also accounts for copies its popup Undo removes. */
function observeUndo(
  undo: InlineUndo,
  onUndone: (ownerRevision: number) => void
): InlineUndo {
  return Object.assign(
    async () => {
      const result = await undo();
      if (result.undone && result.ownerRevision !== undefined)
        onUndone(result.ownerRevision);
      return {
        ...result,
        next: result.next ? observeUndo(result.next, onUndone) : null,
      };
    },
    { isAvailable: undo.isAvailable }
  );
}
