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
  /** Reads again as many rows as are shown (at least one page), keeping the shown rows until the new ones arrive, so
   * a row that is still listed keeps its place and its focus. Resolves when the rows are in, or the read failed. */
  refresh: () => Promise<void>;
};

/** One filter's rows of an import draft, 100 at a time (Show more rows adds the next page). A new draft or filter
 * starts again at the top; a page that arrives for an older one is dropped. After a change (#230) refresh() reads
 * the shown rows again without emptying the list. */
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
  // How many rows are shown, for refresh().
  const shown = useRef(0);
  // refresh runs after a change request returns, possibly after the collector switched chips; it reads the latest
  // import and filter, so it never writes the old chip's rows over the new one's.
  const latest = useRef({ importId, filter });
  latest.current = { importId, filter };
  useEffect(() => {
    shown.current = rows.length;
  }, [rows]);

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

  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    const wanted = Math.max(shown.current, 1);
    setLoadingMore(false);
    try {
      const found: CollectionImportRow[] = [];
      let next: string | null = null;
      do {
        const page = await getCollectionImportRows(
          latest.current.importId,
          latest.current.filter,
          next
        );
        if (generation.current !== mine) return;
        found.push(...page.rows);
        next = page.next_cursor;
      } while (next && found.length < wanted);
      setRows(found);
      setCursor(next);
      setStatus("ready");
    } catch {
      if (generation.current === mine) setStatus("failed");
    }
  }, []);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return {
    status,
    rows,
    more: cursor !== null,
    loadingMore,
    loadMore,
    retry,
    refresh,
  };
}
