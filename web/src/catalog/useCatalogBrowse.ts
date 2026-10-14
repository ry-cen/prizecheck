import { useCallback, useEffect, useRef, useState } from "react";
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
};

function failure(cause: unknown): string {
  return cause instanceof CatalogBrowseError &&
    cause.code === "FORMAT_STANDING_BUSY"
    ? STANDING_BUSY
    : BROWSE_FAILED;
}

/**
 * Catalog's rows from the browse route (GET /api/catalog/editions, #173). A new query loads page one; loadMore (the
 * gallery's infinite scroll) follows the cursor, one request at a time, and stops after a failure until Retry. A cursor answered with 409 (the catalog, the collection or card legality changed) starts again
 * from page one and says so. The page stays mounted while hidden: when it is shown again and the collection or the
 * catalog changed meanwhile, page one is read again.
 */
export function useCatalogBrowse(
  query: BrowseQuery,
  active: boolean
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

  const load = useCallback(async (why = "") => {
    const mine = ++latest.current;
    // No later page of the previous walk may be asked for while this first page is on its way.
    setNextCursor(null);
    setLoading(true);
    try {
      const page = await browseEditions(current.current);
      if (mine !== latest.current) return;
      setFirst(page);
      setEditions(page.editions);
      setNextCursor(page.next_cursor);
      setNotice(why);
      setError(null);
    } catch (cause) {
      if (mine === latest.current)
        setError({ text: failure(cause), more: false });
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
      )
        void load(
          cause.code === "INVENTORY_CHANGED"
            ? COLLECTION_REFRESHED
            : CATALOG_REFRESHED
        );
      else setError({ text: failure(cause), more: true });
    } finally {
      inFlight.current = false;
      setLoadingMore(false);
    }
  }, [nextCursor, load]);

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
          void load(CATALOG_REFRESHED);
        else if (owner.owner_revision !== first.owner_revision)
          void load(COLLECTION_REFRESHED);
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
  };
}
