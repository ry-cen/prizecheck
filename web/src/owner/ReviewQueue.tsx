import {
  Fragment,
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { Button } from "../ui/Button";
import { Pill } from "../ui/Pill";
import { ScrollTable } from "../ui/ScrollTable";
import { PANEL } from "./StatusPanel";

/** One item in a review queue's table (spec "Queues"). */
export type QueueRow = {
  key: string;
  /** The item in a few words; the Review button reads "Review <label>". */
  label: string;
  card: ReactNode;
  setNumber: string;
  kind: ReactNode;
  reports: string;
  /** When the item entered the queue, or null when the queue doesn't record it. */
  opened: string | null;
};

type Props = {
  /** The section's heading and accessible name, for example "Catalog reconciliation". */
  title: string;
  intro: string;
  /** The table's region name. No other region name on the page may contain it, or be contained by it. */
  tableLabel: string;
  rows: QueueRow[];
  emptyText: string;
  /** The key of the row whose review card is open, or null. */
  open: string | null;
  onOpen: (key: string | null) => void;
  /** The open row's review card. `close` folds it and returns focus to the row's Review button. */
  renderCard: (key: string, close: () => void) => ReactNode;
  onRefresh: () => void;
  /** The section's status line: a failed load, a record begun. */
  status: string;
  /** Above the table, for example Begin a record directly. */
  before?: ReactNode;
  /** Below the table, for example Load more. */
  after?: ReactNode;
};

const COLUMNS = ["Card", "Set · number", "Kind", "Reports", "Opened", "Age"];

/** "12 min", "5 h" or "3 d" since `iso`. */
export function age(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/**
 * An Owner controls review queue (#168, spec "Queues"): a ScrollTable of card, set and number, kind,
 * reports, opened, age and Review. Review opens the item's card in a row under it, as wide as the table's
 * visible area and pinned to its left edge while the table scrolls sideways (the ScrollTable is a CSS
 * inline-size container, so 100cqw is its visible width). One card is open at a time.
 *
 * Focus: the card moves focus into itself when it opens (ReviewCard). Close returns it to the row's Review
 * button. When a decision removes the open row, focus would fall to the page, so it moves to the next
 * row's Review button, else the previous row's, else the queue's heading.
 */
export function ReviewQueue({
  title,
  intro,
  tableLabel,
  rows,
  emptyText,
  open,
  onOpen,
  renderCard,
  onRefresh,
  status,
  before,
  after,
}: Props) {
  const headingId = useId();
  const cardId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const shown = useRef<string[]>([]);
  const lastOpen = useRef<string | null>(null);

  useEffect(() => {
    if (open) lastOpen.current = open;
  }, [open]);
  useEffect(() => {
    const previous = shown.current;
    const now = rows.map((row) => row.key);
    shown.current = now;
    const gone = lastOpen.current;
    if (!gone || !previous.includes(gone) || now.includes(gone)) return;
    lastOpen.current = null;
    // Only when the removed card held the focus: a refresh that drops a row leaves focus where it is.
    if (document.activeElement && document.activeElement !== document.body)
      return;
    const index = previous.indexOf(gone);
    const neighbour =
      previous.slice(index + 1).find((key) => now.includes(key)) ??
      previous
        .slice(0, index)
        .reverse()
        .find((key) => now.includes(key));
    (neighbour ? buttons.current.get(neighbour) : heading.current)?.focus();
  }, [rows]);

  function close(key: string) {
    lastOpen.current = null;
    onOpen(null);
    buttons.current.get(key)?.focus();
  }

  return (
    <section aria-labelledby={headingId} className={PANEL}>
      <div className="flex flex-wrap items-center gap-2">
        <h2
          id={headingId}
          ref={heading}
          tabIndex={-1}
          className="m-0 mr-auto text-body font-semibold"
        >
          {title}
        </h2>
        <Button onClick={onRefresh}>Refresh queue</Button>
      </div>
      <p className="m-0 text-meta text-text-muted">{intro}</p>
      {before}
      <p role="status" className="m-0 text-meta">
        {status}
      </p>
      {rows.length ? (
        <ScrollTable label={tableLabel}>
          <thead>
            <tr>
              {COLUMNS.map((column) => (
                <th key={column} scope="col">
                  {column}
                </th>
              ))}
              <th scope="col">Review</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isOpen = row.key === open;
              return (
                <Fragment key={row.key}>
                  <tr className={isOpen ? "bg-surface-selected" : undefined}>
                    <td>{row.card}</td>
                    <td>{row.setNumber}</td>
                    <td>{row.kind}</td>
                    <td className="tabular-nums">{row.reports}</td>
                    <td className="tabular-nums">
                      {row.opened
                        ? new Date(row.opened).toLocaleDateString()
                        : "—"}
                    </td>
                    <td className="tabular-nums">
                      {row.opened ? age(row.opened) : "—"}
                    </td>
                    <td>
                      <Button
                        ref={(element: HTMLButtonElement | null) => {
                          if (element) buttons.current.set(row.key, element);
                          else buttons.current.delete(row.key);
                        }}
                        aria-label={`Review ${row.label}`}
                        aria-expanded={isOpen}
                        aria-controls={isOpen ? cardId : undefined}
                        onClick={() =>
                          isOpen ? close(row.key) : onOpen(row.key)
                        }
                      >
                        Review
                      </Button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      {/* p-0 wins over the table's zero-specificity cell padding (ScrollTable). */}
                      <td colSpan={COLUMNS.length + 1} className="p-0">
                        <div
                          id={cardId}
                          className="sticky left-0 box-border w-[100cqw] whitespace-normal p-4 text-body phone:p-3"
                        >
                          {renderCard(row.key, () => close(row.key))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </ScrollTable>
      ) : (
        <p className="m-0 text-body text-text-muted">{emptyText}</p>
      )}
      {after}
    </section>
  );
}

type CardProps = {
  title: string;
  /** A short status beside the title, for example the item's state. */
  badge?: ReactNode;
  onClose: () => void;
  /** Takes the focus when the card opens: the reason field, where every decision starts. */
  focusRef: RefObject<HTMLElement | null>;
  children: ReactNode;
};

/**
 * A review card inside a queue's inline row (#168): its heading names the item, and Close folds it. When
 * it opens, the reason field takes the focus and the card's top is scrolled into view, so the evidence
 * above the reason stays readable.
 */
export function ReviewCard({
  title,
  badge,
  onClose,
  focusRef,
  children,
}: CardProps) {
  const headingId = useId();
  const article = useRef<HTMLElement>(null);
  useEffect(() => {
    focusRef.current?.focus({ preventScroll: true });
    article.current?.scrollIntoView({ block: "nearest" });
  }, []);
  return (
    <article
      ref={article}
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={headingId} className="m-0 mr-auto text-body font-semibold">
          {title}
        </h3>
        {badge}
        <Button onClick={onClose}>Close</Button>
      </div>
      {children}
    </article>
  );
}

/** A small "Differs" marker for a compared value, so a difference is said in words, not by colour alone. */
export function Differs() {
  return <Pill tone="warn">Differs</Pill>;
}

/** A labelled group of a card's fields, wrapping to as many columns as fit. */
export const FIELDS =
  "grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3";

/** A card's small section heading ("Decide", "Linked reports"). */
export const CARD_HEADING =
  "m-0 text-meta font-semibold uppercase tracking-wide text-text-muted";
