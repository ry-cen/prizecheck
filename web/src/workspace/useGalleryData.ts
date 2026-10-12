import { useCallback, useEffect, useRef, useState } from "react";
import { getCollectionHoldings } from "../collection_generated";
import { HoldingError } from "../holdings_generated";
import {
  appendHoldings,
  EMPTY_GALLERY,
  type GalleryData,
  type GalleryHolding,
  type GalleryQuery,
  type GalleryTotals,
  queryToParams,
  sameListing,
} from "./galleryModel";

/** A cursor became stale mid-walk; the walk restarts from the first page at most this many times. */
const MAX_RESTARTS = 2;
/** Complete listings kept for views shown before, least recently shown first. Every search term is a view. */
const CACHE_SIZE = 12;

const stale = (error: unknown) =>
  error instanceof HoldingError &&
  error.status === 409 &&
  (error.code === "INVENTORY_CHANGED" || error.code === "CATALOG_CHANGED");

/** Loads every page of the Holding listing for the query, in order, in the background.
 * The first page replaces the placeholders; later pages append. A newer query or reload
 * supersedes an older walk, whose late pages are dropped.
 *
 * Ticket 121: complete listings are kept per view, so returning to a view shows its tiles at once
 * while it is read again out of sight. The re-read replaces them only when it is complete and
 * differs. A kept listing is only ever shown at the newest revisions this workspace has read: any
 * page with other revisions drops them all, and so does a reload. The cache lives in this hook, so
 * it goes with the signed-in workspace. */
export function useGalleryData(
  query: GalleryQuery,
  /** The newest owner revision read outside the gallery (the Location tree's). A kept listing older than
   * it isn't shown: this tab's own change (a new Location) would otherwise raise the stale-collection banner. */
  knownRevision: number | null
): GalleryData & { reload: () => void } {
  // Data is tagged with the query key it was loaded for, so a view change never shows the old frame.
  const [loaded, setLoaded] = useState<{ key: string; data: GalleryData }>({
    key: "",
    data: EMPTY_GALLERY,
  });
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const cache = useRef(new Map<string, GalleryData>()).current;
  // The revisions every kept listing was read at.
  const cachedAt = useRef<{ owner: number; catalog: number } | null>(null);
  const floor = useRef(knownRevision);
  floor.current = knownRevision;
  const key = JSON.stringify(queryToParams(query));

  const kept = (forKey: string) => {
    const entry = cache.get(forKey);
    return entry &&
      (floor.current === null || (entry.ownerRevision ?? 0) >= floor.current)
      ? entry
      : undefined;
  };

  useEffect(() => {
    const id = ++generation.current;
    const live = () => generation.current === id;
    const params = JSON.parse(key) as ReturnType<typeof queryToParams>;
    const setData = (update: (previous: GalleryData) => GalleryData) =>
      setLoaded((previous) => ({
        key,
        data: update(previous.key === key ? previous.data : EMPTY_GALLERY),
      }));
    const keep = (data: GalleryData) => {
      // Re-inserting moves the view to the newest end; the oldest go first.
      cache.delete(key);
      cache.set(key, data);
      while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
    };
    const shown = kept(key);
    // A kept listing is shown at once and read again quietly: no page is published until the walk is complete.
    const quiet = shown !== undefined;
    if (shown) keep(shown);
    setLoaded({ key, data: shown ?? EMPTY_GALLERY });
    void (async () => {
      for (let restarts = 0; ; restarts++) {
        let holdings: GalleryData["holdings"] = [];
        let loadedCopies = 0;
        let totals: GalleryTotals | null = null;
        // One Map per walk, filled page by page and published with each page (GalleryData.byKey).
        const byKey = new Map<string, GalleryHolding>();
        let cursor: string | undefined;
        try {
          do {
            const page = await getCollectionHoldings(params, cursor);
            if (!live()) return;
            const at = cachedAt.current;
            if (
              !at ||
              at.owner !== page.owner_revision ||
              at.catalog !== page.catalog_revision
            ) {
              cache.clear();
              cachedAt.current = {
                owner: page.owner_revision,
                catalog: page.catalog_revision,
              };
            }
            const first = cursor === undefined;
            ({ holdings, loadedCopies } = appendHoldings(
              holdings,
              loadedCopies,
              page.holdings,
              byKey
            ));
            if (first && page.totals)
              totals = {
                holdings: page.totals.holdings,
                editions: page.totals.editions,
                copies: Number(page.totals.copies),
              };
            cursor = page.next_cursor ?? undefined;
            const done = cursor === undefined;
            const snapshot = { holdings, loadedCopies, byKey };
            if (done && totals) {
              const complete: GalleryData = {
                ...snapshot,
                totals,
                ownerRevision: page.owner_revision,
                catalogRevision: page.catalog_revision,
                status: "ready",
                error: null,
              };
              // An unchanged re-read keeps the shown listing, so nothing on screen re-renders.
              if (shown && sameListing(shown, complete)) {
                keep(shown);
                return;
              }
              keep(complete);
              setLoaded({ key, data: complete });
              return;
            }
            if (!quiet)
              setData((previous) => ({
                ...snapshot,
                totals: totals ?? previous.totals,
                ownerRevision: page.owner_revision,
                catalogRevision: page.catalog_revision,
                status: done ? "ready" : "partial",
                error: null,
              }));
          } while (cursor !== undefined);
          return;
        } catch (error) {
          if (!live()) return;
          if (stale(error) && restarts < MAX_RESTARTS) continue;
          // A failed re-read keeps showing the kept listing; the next visit to this view loads it afresh.
          if (quiet) {
            cache.delete(key);
            return;
          }
          setData((previous) =>
            previous.totals
              ? {
                  ...previous,
                  status: "partial",
                  error: "Some cards couldn't be loaded.",
                }
              : {
                  ...EMPTY_GALLERY,
                  status: "error",
                  error: "Cards are temporarily unavailable.",
                }
          );
          return;
        }
      }
    })();
    return () => {
      generation.current++;
    };
    // `kept` reads refs only: a new tree revision never restarts the walk.
  }, [key, attempt]);

  // A reload follows a Move, Removal, Add, correction or the stale banner, so any kept listing may be out of
  // date. It drops them all and the walk in flight, and empties this view until its first page returns:
  // useSelection, useInventoryActions and CorrectionsNotice rely on that.
  const reload = useCallback(() => {
    generation.current++;
    cache.clear();
    setAttempt((n) => n + 1);
  }, [cache]);
  return {
    ...(loaded.key === key ? loaded.data : (kept(key) ?? EMPTY_GALLERY)),
    reload,
  };
}
