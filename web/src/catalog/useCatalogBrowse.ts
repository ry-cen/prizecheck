import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  browseEditions,
  CatalogBrowseError,
  type BrowseEdition,
  type BrowsePage,
  type BrowseQuery,
} from "../catalog_browse_generated";
import { getCollectionRevision } from "../collection_generated";
import { getCatalogStatus } from "../generated";
import {
  BROWSE_FAILED,
  CATALOG_REFRESHED,
  COLLECTION_REFRESHED,
  STANDING_BUSY,
} from "./catalogText";

/** Copies the collector's own command changed for one Card Edition: added (a batch add) or, below 0, taken out
 * again (its Undo). */
export type OwnChange = { editionId: string; added: number };

export type CatalogBrowse = {
  /** The first page of the current query: its search reading, counts and revisions. Null before the first answer. */
  first: BrowsePage | null;
  /** Every row loaded so far, page after page. */
  editions: BrowseEdition[];
  nextCursor: string | null;
  /** A first page is on its way (the rows shown are the previous query's until it arrives). */
  loading: boolean;
  loadingMore: boolean;
  /** "changed, refreshed": the walk started again from page one, and why. */
  notice: string;
  /** The last request failed; Retry repeats it. */
  error: string;
  /** The failed request was a later page: the error shows at the end of the gallery, and loading waits for Retry. */
  errorMore: boolean;
  loadMore: () => void;
  retry: () => void;
  /** One command of the collector's own on this page changed these Editions' copies (a batch add from the CardPopup or
   * Add mode, or its Undo, #174/#175): their tiles show the new counts at once, and the next page's 409 for that one
   * owner revision starts again quietly, without "Your collection changed". */
  noteAdded: (changes: readonly OwnChange[], ownerRevision: number) => void;
};

// A walk that starts again after a 409 reads as many rows as were shown, up to this many, so the gallery and an open
// CardPopup keep their place instead of falling back to page one.
const RESTART_DEPTH = 600;

function failure(cause: unknown): string {
  return cause instanceof CatalogBrowseError &&
    cause.code === "FORMAT_STANDING_BUSY"
    ? STANDING_BUSY
    : BROWSE_FAILED;
}

/**
 * Catalog's rows from the browse route (GET /api/catalog/editions, #173). A new query loads page one; loadMore (the
 * gallery's infinite scroll) follows the cursor, one request at a time, and stops after a failure until Retry. A cursor answered with 409 (the catalog, the collection or card legality changed) starts again
 * from page one and says so, reading as many rows again as were shown (up to RESTART_DEPTH). A change the collector
 * made here (noteAdded) starts again without the notice. The page stays mounted while hidden: when it is shown again
 * and the collection or the catalog changed meanwhile, page one is read again.
 */
export function useCatalogBrowse(
  query: BrowseQuery,
  active: boolean,
  /** The gallery's own list (its `<li>`s carry `data-edition-id`): where keyboard focus is kept across a restart. The
   * Catalog page stays mounted while hidden and Collection renders a second gallery, so no document-wide query. */
  list?: RefObject<HTMLElement | null>
): CatalogBrowse {
  const [first, setFirst] = useState<BrowsePage | null>(null);
  const [editions, setEditions] = useState<BrowseEdition[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<{ text: string; more: boolean } | null>(
    null
  );
  // Only the latest first-page read may set the rows; a page that arrives after a newer query is dropped.
  const latest = useRef(0);
  const key = JSON.stringify(query);
  const current = useRef(query);
  current.current = query;
  const shownRows = useRef(0);
  shownRows.current = editions.length;
  const firstRef = useRef<BrowsePage | null>(null);
  firstRef.current = first;
  // Owner revisions the collector's own Adds on this page moved past the first page's.
  const ownChanges = useRef(0);

  const restoreFocus = useRef<{ id: string; index: number } | null>(null);
  // After a restart, a tile that lost focus gets it back: the same Edition's, else the one at its place, else the last.
  useEffect(() => {
    const wanted = restoreFocus.current;
    if (!wanted || editions.length === 0 || loading) return;
    restoreFocus.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const rows = Array.from(
      list?.current?.querySelectorAll<HTMLElement>("[data-edition-id]") ?? []
    );
    // The tile's button, even when a quick add button held the focus.
    (
      rows.find((row) => row.dataset.editionId === wanted.id) ??
      rows[Math.min(wanted.index, rows.length - 1)]
    )
      ?.querySelector<HTMLElement>("button")
      ?.focus();
  }, [editions, loading, list]);

  const load = useCallback(async (why = "", depth = 0) => {
    const mine = ++latest.current;
    // Own Adds counted before this read; ones that land while it runs stay counted.
    const ownAtStart = ownChanges.current;
    // No later page of the previous walk may be asked for while this first page is on its way.
    setNextCursor(null);
    setLoading(true);
    try {
      const page = await browseEditions(current.current);
      if (mine !== latest.current) return;
      let rows = page.editions;
      let cursor = page.next_cursor;
      try {
        while (cursor && rows.length < Math.min(depth, RESTART_DEPTH)) {
          const more = await browseEditions(current.current, cursor);
          if (mine !== latest.current) return;
          rows = [...rows, ...more.editions];
          cursor = more.next_cursor;
        }
      } catch {
        // Refilling is a courtesy: on any failure, keep page one and its cursor.
        rows = page.editions;
        cursor = page.next_cursor;
      }
      ownChanges.current = Math.max(0, ownChanges.current - ownAtStart);
      setFirst(page);
      setEditions(rows);
      setNextCursor(cursor);
      setNotice(why);
      setError(null);
    } catch (cause) {
      if (mine === latest.current) {
        restoreFocus.current = null;
        setError({ text: failure(cause), more: false });
      }
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [key, load]);

  // One page request at a time: the sentinel and the last tile's focus can both ask before a render.
  const inFlight = useRef(false);
  const loadMore = useCallback(async () => {
    if (!nextCursor || inFlight.current) return;
    inFlight.current = true;
    const mine = latest.current;
    setLoadingMore(true);
    try {
      const page = await browseEditions(current.current, nextCursor);
      if (mine !== latest.current) return;
      setEditions((previous) => [...previous, ...page.editions]);
      setNextCursor(page.next_cursor);
      setError(null);
    } catch (cause) {
      if (mine !== latest.current) return;
      if (
        cause instanceof CatalogBrowseError &&
        (cause.status === 409 || cause.code === "INVALID_CURSOR")
      ) {
        let why = CATALOG_REFRESHED;
        if (cause.code === "INVENTORY_CHANGED") {
          const quiet = await onlyOwnChanges();
          if (mine !== latest.current) return;
          why = quiet ? "" : COLLECTION_REFRESHED;
        }
        // Keyboard focus on a tile when the walk starts again (#196): put it back once the rows are redrawn.
        restoreFocus.current = focusedTile(list?.current ?? null);
        void load(why, shownRows.current);
      } else setError({ text: failure(cause), more: true });
    } finally {
      inFlight.current = false;
      setLoadingMore(false);
    }
  }, [nextCursor, load, list]);

  // True when the owner revision moved only by the collector's own Adds on this page since the first page.
  async function onlyOwnChanges(): Promise<boolean> {
    const page = firstRef.current;
    if (!page || ownChanges.current === 0) return false;
    try {
      const { owner_revision } = await getCollectionRevision();
      return owner_revision === page.owner_revision + ownChanges.current;
    } catch {
      return false;
    }
  }

  const noteAdded = useCallback(
    (changes: readonly OwnChange[], ownerRevision: number) => {
      const page = firstRef.current;
      // One command moves the owner revision once, however many Editions it changed.
      if (page && ownerRevision > page.owner_revision) ownChanges.current += 1;
      const added = new Map(
        changes.map((change) => [change.editionId, change.added])
      );
      setEditions((rows) =>
        rows.map((row) =>
          added.has(row.edition_id)
            ? {
                ...row,
                owned: Math.max(0, row.owned + added.get(row.edition_id)!),
              }
            : row
        )
      );
    },
    []
  );

  // Shown again after another page: read page one again only if the collection or the catalog moved.
  const shown = useRef(active);
  useEffect(() => {
    const returning = active && !shown.current;
    shown.current = active;
    if (!returning || !first) return;
    let cancelled = false;
    Promise.all([getCollectionRevision(), getCatalogStatus()])
      .then(([owner, catalog]) => {
        if (cancelled) return;
        if (catalog.revision !== first.catalog_revision)
          void load(CATALOG_REFRESHED, shownRows.current);
        else if (
          owner.owner_revision !==
          first.owner_revision + ownChanges.current
        )
          void load(COLLECTION_REFRESHED, shownRows.current);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active, first, load]);

  return {
    first,
    editions,
    nextCursor,
    loading,
    loadingMore,
    notice,
    error: error?.text ?? "",
    errorMore: error?.more ?? false,
    loadMore: () => void loadMore(),
    retry: () => void (error?.more ? loadMore() : load()),
    noteAdded,
  };
}

/** The gallery row (tile or its quick add) that holds keyboard focus, and its place among the rows. */
function focusedTile(
  list: HTMLElement | null
): { id: string; index: number } | null {
  const row = document.activeElement?.closest<HTMLElement>("[data-edition-id]");
  if (!list || !row?.dataset.editionId || !list.contains(row)) return null;
  const rows = Array.from(list.querySelectorAll("[data-edition-id]"));
  return { id: row.dataset.editionId, index: rows.indexOf(row) };
}
