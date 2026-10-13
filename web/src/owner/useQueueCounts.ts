import { useCallback, useEffect, useState } from "react";
import { getOwnerMissingCardReports } from "../generated";
import {
  getAttributeQueue,
  getCardIdentityQueue,
  getMetadataQueue,
} from "../metadata_generated";
import type { OwnerSection } from "./sections";

/** A queue tab's count: "3", or "100+" when the queue has more than its first page. Absent until it loads,
 * or when it can't be read. */
export type QueueCounts = Partial<Record<OwnerSection, string>>;

const paged = (page: { items: unknown[]; next_cursor: string | null }) =>
  `${page.items.length}${page.next_cursor ? "+" : ""}`;

/**
 * How many items wait in the Metadata, Attributes, Reprints and Missing cards queues. The Catalog count
 * comes from the operational status (its pending catalog reviews), which the page already reads. Counts
 * are read again whenever `section` changes, so a decision made inside a queue shows in its count once the
 * owner switches tab, without the queue components knowing about the counts.
 */
export function useQueueCounts(section: OwnerSection) {
  const [counts, setCounts] = useState<QueueCounts>({});
  const refresh = useCallback(() => {
    const read = (
      id: OwnerSection,
      load: () => Promise<string>
    ): Promise<void> =>
      load().then(
        (count) => setCounts((previous) => ({ ...previous, [id]: count })),
        () =>
          setCounts((previous) => {
            const next = { ...previous };
            delete next[id];
            return next;
          })
      );
    void Promise.all([
      read("metadata", () => getMetadataQueue().then(paged)),
      read("attributes", () => getAttributeQueue().then(paged)),
      // The Reprints table lists Card Identities, each with one or more queued Printings (#171).
      read("reprints", () =>
        getCardIdentityQueue().then(
          (page) =>
            `${new Set(page.items.map((item) => item.identity_id)).size}${page.next_cursor ? "+" : ""}`
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
    ]);
  }, []);
  useEffect(refresh, [section, refresh]);
  return { counts, refresh };
}
