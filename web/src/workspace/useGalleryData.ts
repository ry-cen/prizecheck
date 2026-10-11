import { useCallback, useEffect, useRef, useState } from "react";
import { getCollectionHoldings } from "../collection_generated";
import { HoldingError } from "../holdings_generated";
import {
  appendHoldings,
  EMPTY_GALLERY,
  type GalleryData,
  type GalleryQuery,
} from "./galleryModel";

/** A cursor became stale mid-walk; the walk restarts from the first page at most this many times. */
const MAX_RESTARTS = 2;

const stale = (error: unknown) =>
  error instanceof HoldingError &&
  error.status === 409 &&
  (error.code === "INVENTORY_CHANGED" || error.code === "CATALOG_CHANGED");

/** Loads every page of the Holding listing for the query, in order, in the background.
 * The first page replaces the placeholders; later pages append. A newer query or reload
 * supersedes an older walk, whose late pages are dropped. */
export function useGalleryData(
  query: GalleryQuery
): GalleryData & { reload: () => void } {
  const [data, setData] = useState<GalleryData>(EMPTY_GALLERY);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const locationId = query.view === "all" ? undefined : query.view;

  useEffect(() => {
    const id = ++generation.current;
    const live = () => generation.current === id;
    setData(EMPTY_GALLERY);
    void (async () => {
      for (let restarts = 0; ; restarts++) {
        let holdings: GalleryData["holdings"] = [];
        let loadedCopies = 0;
        let cursor: string | undefined;
        try {
          do {
            const page = await getCollectionHoldings(
              locationId ? { location_id: locationId } : {},
              cursor
            );
            if (!live()) return;
            const first = cursor === undefined;
            ({ holdings, loadedCopies } = appendHoldings(
              holdings,
              loadedCopies,
              page.holdings
            ));
            cursor = page.next_cursor ?? undefined;
            const done = cursor === undefined;
            const snapshot = { holdings, loadedCopies };
            setData((previous) => ({
              ...snapshot,
              totals:
                first && page.totals
                  ? {
                      holdings: page.totals.holdings,
                      editions: page.totals.editions,
                      copies: Number(page.totals.copies),
                    }
                  : previous.totals,
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
  }, [locationId, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...data, reload };
}
