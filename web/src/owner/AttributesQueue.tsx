import { Fragment, useEffect, useId, useRef, useState } from "react";
import {
  getAttributeQueue,
  type AttributeEvidence,
} from "../metadata_generated";
import { Button } from "../ui/Button";
import { ScrollTable } from "../ui/ScrollTable";
import { useToast } from "../ui/Toast";
import { AttributeReviewCard } from "./AttributeReviewCard";
import { age, queueKind } from "./attributeValues";
import { PANEL } from "./StatusPanel";

/** Owner controls' columns, in order (spec "Queues"). */
const COLUMNS = 7;

/**
 * Owner controls' Attributes tab (#170): the card attribute review queue as a ScrollTable of card, set and
 * number, kind, reports, opened, age and Review, with Load more past the first page. Review opens the review
 * card in an inline row under its item, as wide as the table's visible area and pinned to its left edge while
 * the table scrolls sideways; one item is open at a time. Opening it moves focus to the card's heading, and
 * Close returns focus to the row's Review button. A decision that takes the Printing out of the queue removes
 * its row; every recorded decision shows a toast and reads the tab counts again (`onDecided`).
 */
export function AttributesQueue({ onDecided }: { onDecided: () => void }) {
  const headingId = useId();
  const cardIds = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const reviewButtons = useRef(new Map<string, HTMLButtonElement>());
  const toast = useToast();
  const [items, setItems] = useState<AttributeEvidence[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let current = true;
    getAttributeQueue().then(
      (page) => {
        if (!current) return;
        setItems(page.items);
        setNext(page.next_cursor);
      },
      () => current && setFailed(true)
    );
    return () => {
      current = false;
    };
  }, []);

  async function loadMore() {
    if (!next) return;
    setLoadingMore(true);
    try {
      const page = await getAttributeQueue(next);
      setItems((previous) => [...(previous ?? []), ...page.items]);
      setNext(page.next_cursor);
    } catch {
      setFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }

  function close(printingId: string) {
    setOpen(null);
    reviewButtons.current.get(printingId)?.focus();
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
          (previous ?? []).map((item) =>
            item.printing_id === printingId ? fresh : item
          )
        );
      return;
    }
    setItems((previous) =>
      (previous ?? []).filter((item) => item.printing_id !== printingId)
    );
    setOpen(null);
    heading.current?.focus();
  }

  return (
    <section aria-labelledby={headingId} className={PANEL}>
      <h2
        id={headingId}
        ref={heading}
        tabIndex={-1}
        className="m-0 text-body font-semibold"
      >
        Card attributes
      </h2>
      <p className="m-0 text-body text-text-muted">
        Printings with an open collector report, and manual Printings with no
        attributes yet. A correction overrides the derived value of each
        attribute it sets until it is removed.
      </p>
      {failed && (
        <p role="alert" className="m-0 text-meta text-danger">
          Unable to load the attribute review queue.
        </p>
      )}
      {items === null ? (
        !failed && (
          <p className="m-0 text-meta text-text-muted">Loading the queue…</p>
        )
      ) : items.length === 0 ? (
        <p className="m-0 text-body text-text-muted">
          Nothing waits for review.
        </p>
      ) : (
        <ScrollTable label="Attribute review queue">
          <thead>
            <tr>
              <th scope="col">Card</th>
              <th scope="col">Set and number</th>
              <th scope="col">Kind</th>
              <th scope="col">Reports</th>
              <th scope="col">Opened</th>
              <th scope="col">Age</th>
              <th scope="col">
                <span className="sr-only">Review</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const name = item.name ?? "Unnamed Printing";
              const cardId = `${cardIds}-${item.printing_id}`;
              const isOpen = open === item.printing_id;
              return (
                <Fragment key={item.printing_id}>
                  <tr>
                    <td>{name}</td>
                    <td>
                      {[item.set_id, item.collector_number]
                        .filter(Boolean)
                        .join(" · ") || "None"}
                    </td>
                    <td>{queueKind(item)}</td>
                    <td className="tabular-nums">{item.reports.length}</td>
                    <td>{new Date(item.opened_at).toLocaleDateString()}</td>
                    <td className="tabular-nums">{age(item.opened_at, now)}</td>
                    <td>
                      <Button
                        ref={(button) => {
                          if (button)
                            reviewButtons.current.set(item.printing_id, button);
                          else reviewButtons.current.delete(item.printing_id);
                        }}
                        aria-label={`Review ${name}`}
                        aria-expanded={isOpen}
                        aria-controls={isOpen ? cardId : undefined}
                        onClick={() =>
                          setOpen(isOpen ? null : item.printing_id)
                        }
                      >
                        Review
                      </Button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={COLUMNS} className="p-0">
                        <div
                          id={cardId}
                          className="sticky left-0 box-border w-[100cqw] p-2 whitespace-normal"
                        >
                          <AttributeReviewCard
                            item={item}
                            onClose={() => close(item.printing_id)}
                            onDone={(message, removed, fresh) =>
                              done(item.printing_id, message, removed, fresh)
                            }
                          />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </ScrollTable>
      )}
      {next && (
        <div>
          <Button disabled={loadingMore} onClick={() => void loadMore()}>
            Load more
          </Button>
        </div>
      )}
    </section>
  );
}
