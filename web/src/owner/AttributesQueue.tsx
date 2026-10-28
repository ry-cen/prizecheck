import { useEffect, useRef, useState } from "react";
import {
  getAttributeQueue,
  type AttributeEvidence,
} from "../metadata_generated";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { AttributeReviewCard } from "./AttributeReviewCard";
import { AttributeSearch } from "./AttributeSearch";
import { queueKind } from "./attributeValues";
import { ReviewQueue } from "./ReviewQueue";

/**
 * Owner controls' Attributes tab (#170, #193): the card attribute review queue on the shared ReviewQueue, a
 * ScrollTable of card, set and number, kind, reports, opened, age and Review, with Refresh queue and Load more
 * past the first page. Review opens the review card in an inline row under its item. A decision that takes
 * the Printing out of the queue removes its row (ReviewQueue moves focus to a neighbouring row); every recorded
 * decision shows a toast and reads the tab counts again (`onDecided`).
 */
export function AttributesQueue({ onDecided }: { onDecided: () => void }) {
  const toast = useToast();
  const section = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState<AttributeEvidence[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);

  async function load() {
    try {
      const page = await getAttributeQueue();
      setItems(page.items);
      setNext(page.next_cursor);
      setOpen((current) =>
        current && page.items.some((item) => item.printing_id === current)
          ? current
          : null
      );
      setStatus("");
    } catch {
      setStatus("Unable to load the attribute review queue.");
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function loadMore() {
    if (!next) return;
    setLoadingMore(true);
    try {
      const page = await getAttributeQueue(next);
      setItems((previous) => [...previous, ...page.items]);
      setNext(page.next_cursor);
    } catch {
      setStatus("Unable to load more of the attribute review queue.");
    } finally {
      setLoadingMore(false);
    }
  }

  /** Opens a queued Printing's row; one that is already open has nothing to open, so its reason field takes focus. */
  function openQueued(printingId: string) {
    if (open === printingId) {
      // One row is open at a time: its Review button names the card it controls.
      const controls = section.current
        ?.querySelector('button[aria-expanded="true"][aria-controls]')
        ?.getAttribute("aria-controls");
      document
        .getElementById(controls ?? "")
        ?.querySelector<HTMLTextAreaElement>("textarea")
        ?.focus();
      return;
    }
    setOpen(printingId);
  }

  function done(
    printingId: string,
    message: string,
    removed: boolean,
    fresh?: AttributeEvidence
  ) {
    toast.show({ message });
    onDecided();
    if (!removed) {
      if (fresh)
        setItems((previous) =>
          previous.map((item) =>
            item.printing_id === printingId ? fresh : item
          )
        );
      return;
    }
    setItems((previous) =>
      previous.filter((item) => item.printing_id !== printingId)
    );
    setOpen(null);
  }

  return (
    <div ref={section}>
      <ReviewQueue
        title="Card attributes"
        intro="Printings with an open collector report, and manual Printings with no attributes yet. A correction overrides the derived value of each attribute it sets until it is removed."
        tableLabel="Attribute review queue"
        rows={items.map((item) => ({
          key: item.printing_id,
          label: item.name ?? "Unnamed Printing",
          card: item.name ?? "Unnamed Printing",
          setNumber:
            [item.set_id, item.collector_number].filter(Boolean).join(" · ") ||
            "None",
          kind: queueKind(item),
          reports: String(item.reports.length),
          opened: item.opened_at,
        }))}
        emptyText="Nothing waits for review."
        open={open}
        onOpen={setOpen}
        renderCard={(key, close) => {
          const item = items.find((entry) => entry.printing_id === key);
          return (
            item && (
              <AttributeReviewCard
                key={key}
                item={item}
                onClose={close}
                onDone={(message, removed, fresh) =>
                  done(key, message, removed, fresh)
                }
              />
            )
          );
        }}
        onRefresh={() => void load()}
        status={status}
        before={
          <AttributeSearch
            queued={(printingId) =>
              items.some((item) => item.printing_id === printingId)
            }
            onOpenQueued={openQueued}
            onDone={(message) => {
              toast.show({ message });
              onDecided();
              // A manual Printing may have left or joined the queue.
              void load();
            }}
          />
        }
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
    </div>
  );
}
