import { useEffect, useState } from "react";
import {
  getCardIdentityQueue,
  type CardIdentityQueueItem,
} from "../metadata_generated";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { ReprintReviewCard } from "./ReprintReviewCard";
import { identityRows, place, type IdentityRow } from "./reprintValues";
import { ReviewQueue } from "./ReviewQueue";

/**
 * Owner controls' Reprints queue (#171, spec "Missing cards and Owner controls"): the Card Identities with a
 * manually approved Printing in no Reprint Group (the only way such a Printing joins one is this review),
 * as a ReviewQueue table with Load more past the route's first 100 Printings. Review opens the identity's
 * card inline. A decision shows a toast and reads the tab counts again; the row goes when the identity no
 * longer has an ungrouped manual Printing, and an identity merge reads the queue again, since the merged
 * Printings now wait under the surviving identity's name. There are no collector reports for Reprint
 * Groups, so Reports is "—".
 */
export function ReprintsQueue({ onChanged }: { onChanged: () => void }) {
  const toast = useToast();
  const [items, setItems] = useState<CardIdentityQueueItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);

  async function load() {
    try {
      const page = await getCardIdentityQueue();
      setItems(page.items);
      setNext(page.next_cursor);
      setOpen((current) =>
        current && page.items.some((item) => item.identity_id === current)
          ? current
          : null
      );
      setStatus("");
    } catch {
      setStatus("Unable to load the Reprint Groups queue.");
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function loadMore() {
    if (!next) return;
    setLoadingMore(true);
    try {
      const page = await getCardIdentityQueue(next);
      setItems((previous) => [...previous, ...page.items]);
      setNext(page.next_cursor);
    } catch {
      setStatus("Unable to load more of the Reprint Groups queue.");
    } finally {
      setLoadingMore(false);
    }
  }

  function done(
    row: IdentityRow,
    message: string,
    removed: boolean,
    reload: boolean
  ) {
    toast.show({ message });
    onChanged();
    if (removed) {
      setItems((previous) =>
        previous.filter((item) => item.identity_id !== row.identityId)
      );
      setOpen(null);
    }
    // A move can place one of several queued Printings, and an identity merge hands its Printings to
    // the surviving identity's row, so read the queue again. An open card stays open while its identity
    // is listed.
    if (reload || !removed) void load();
  }

  const rows = identityRows(items);
  return (
    <ReviewQueue
      title="Reprint Groups"
      intro="Card Identities with a manually approved Printing in no Reprint Group. A manual Printing joins a group only through this review. The card can also move other Printings, merge groups, or merge the Card Identity into another."
      tableLabel="Card Identity review queue"
      rows={rows.map((row) => ({
        key: row.identityId,
        label: row.name,
        card: row.name,
        setNumber: row.printings.map(place).join(", "),
        kind:
          row.printings.length === 1
            ? "Manual Printing in no group"
            : `${row.printings.length} manual Printings in no group`,
        reports: "—",
        opened: row.openedAt,
      }))}
      emptyText="Nothing waits for review."
      open={open}
      onOpen={setOpen}
      renderCard={(key, close) => {
        const row = rows.find((entry) => entry.identityId === key);
        return (
          row && (
            <ReprintReviewCard
              key={key}
              row={row}
              onClose={close}
              onDone={(message, removed, reload) =>
                done(row, message, removed, reload)
              }
            />
          )
        );
      }}
      onRefresh={() => void load()}
      status={status}
      after={
        next && (
          <div>
            <Button disabled={loadingMore} onClick={() => void loadMore()}>
              Load more
            </Button>
          </div>
        )
      }
    />
  );
}
