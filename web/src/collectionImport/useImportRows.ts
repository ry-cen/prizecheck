import { useCallback, useEffect, useRef, useState } from "react";
import {
  getCollectionImportRows,
  type CollectionImportRow,
  type CollectionImportRowFilter,
} from "../collection_import_generated";

export type ImportRows = {
  status: "loading" | "ready" | "failed";
  rows: CollectionImportRow[];
  /** Whether the API has more rows after these. */
  more: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  retry: () => void;
};

/** One filter's rows of an import draft, 100 at a time (Show more rows adds the next page). A new draft or filter
 * starts again at the top; a page that arrives for an older one is dropped. */
export function useImportRows(
  importId: string,
  filter: CollectionImportRowFilter
): ImportRows {
  const [rows, setRows] = useState<CollectionImportRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<ImportRows["status"]>("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const mine = ++generation.current;
    setStatus("loading");
    setRows([]);
    setCursor(null);
    setLoadingMore(false);
    getCollectionImportRows(importId, filter)
      .then((page) => {
        if (generation.current !== mine) return;
        setRows(page.rows);
        setCursor(page.next_cursor);
        setStatus("ready");
      })
      .catch(() => {
        if (generation.current === mine) setStatus("failed");
      });
  }, [importId, filter, attempt]);

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return;
    const mine = generation.current;
    setLoadingMore(true);
    getCollectionImportRows(importId, filter, cursor)
      .then((page) => {
        if (generation.current !== mine) return;
        setRows((previous) => [...previous, ...page.rows]);
        setCursor(page.next_cursor);
        setLoadingMore(false);
      })
      .catch(() => {
        if (generation.current !== mine) return;
        setStatus("failed");
        setLoadingMore(false);
      });
  }, [importId, filter, cursor, loadingMore]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return {
    status,
    rows,
    more: cursor !== null,
    loadingMore,
    loadMore,
    retry,
  };
}
