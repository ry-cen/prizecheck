import { useReadOnShow } from "../shell/keptRead";
import { useCallback, useEffect, useRef, useState } from "react";
import { getOwnerMissingCardReports } from "../generated";
import { getOwnerTradeReports } from "../social_generated";
import {
  getAttributeQueue,
  getCardIdentityQueue,
  getLikelyReprints,
  getMetadataQueue,
} from "../metadata_generated";
import type { OwnerSection } from "./sections";

/** A queue tab's count: "3", or "100+" when the queue has more than its first page. Absent until it loads,
 * or when it can't be read. */
export type QueueCounts = Partial<Record<OwnerSection, string>>;

const paged = (page: { items: unknown[]; next_cursor: string | null }) =>
  `${page.items.length}${page.next_cursor ? "+" : ""}`;

/**
 * How many items wait in the Metadata, Attributes, Reprints, Missing cards and Trade reports queues. The Catalog count
 * comes from the operational status (its pending catalog reviews), which the page already reads. Counts
 * are read again whenever `section` changes, so a decision made inside a queue shows in its count once the
 * owner switches tab, without the queue components knowing about the counts.
 */
export function useQueueCounts(section: OwnerSection, active: boolean) {
  const [counts, setCounts] = useState<QueueCounts>({});
  const generation = useRef(0);
  const [settled, setSettled] = useState(false);
  const [failed, setFailed] = useState(false);
  const refresh = useCallback((quiet = false) => {
    const mine = ++generation.current;
    let failure = false;
    const read = (
      id: OwnerSection,
      load: () => Promise<string>
    ): Promise<void> =>
      load().then(
        (count) => {
          if (mine === generation.current)
            setCounts((previous) => ({ ...previous, [id]: count }));
        },
        () => {
          failure = true;
          if (quiet || mine !== generation.current) return;
          setCounts((previous) => {
            const next = { ...previous };
            delete next[id];
            return next;
          });
        }
      );
    void Promise.all([
      read("metadata", () => getMetadataQueue().then(paged)),
      read("attributes", () => getAttributeQueue().then(paged)),
      // The Reprints table lists Card Identities, each with one or more queued Printings (#171).
      read("reprints", () =>
        Promise.all([getCardIdentityQueue(), getLikelyReprints()]).then(
          ([page, likely]) =>
            `${new Set(page.items.map((item) => item.identity_id)).size + likely.items.length}${page.next_cursor || likely.next_cursor ? "+" : ""}`
        )
      ),
      read("missing", () =>
        getOwnerMissingCardReports().then((reports) =>
          String(
            reports.filter(
              (report) =>
                report.status === "pending" || report.status === "needs_info"
            ).length
          )
        )
      ),
      read("trade-reports", () =>
        getOwnerTradeReports({ status: "open" }).then((list) =>
          String(list.open_count)
        )
      ),
    ]).then(() => {
      if (mine !== generation.current) return;
      setSettled(true);
      setFailed(failure);
    });
  }, []);
  useEffect(() => refresh(), [section, refresh]);
  useReadOnShow(active, failed, (quiet) => refresh(quiet));
  return { counts, settled, refresh: () => refresh() };
}
