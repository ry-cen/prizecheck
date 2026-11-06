import { TradingAvailability } from "./TradingAvailability";
import { itemState, timelineText } from "./threadText";
import { waitingAction } from "./threadPresentation";
import { useEffect, useRef, useState } from "react";
import { getLoans, getTrades, type ThreadItem } from "../social_generated";
import { useLoansChanged, usePulseChanged } from "../inbox/Inbox";
import { useFirstReadSettled, useReadOnShow } from "../shell/keptRead";
import { Button } from "../ui/Button";
const GROUPS = ["needs_you", "open", "out_now", "pending", "done"] as const;
const TITLES = {
  needs_you: "Needs you",
  open: "Open",
  out_now: "Out now",
  pending: "Pending",
  done: "Done",
};
export function ThreadList({
  kind,
  active,
  onOpen,
  selected,
  revision = 0,
}: {
  kind: "trade" | "loan";
  active: boolean;
  onOpen: (id: string) => void;
  selected?: string | null;
  revision?: number;
}) {
  const [rows, setRows] = useState<ThreadItem[] | null>(null);
  const lastRows = useRef(rows);
  lastRows.current = rows;
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [readFinished, setReadFinished] = useState(0);
  const changed = useLoansChanged(),
    pulse = usePulseChanged();
  const root = useRef<HTMLDivElement>(null),
    previous = useRef(selected);
  const restore = useRef<{ id: string; node: HTMLAnchorElement | null } | null>(
    null
  );
  const reading = useRef<AbortController | null>(null);
  useFirstReadSettled(rows !== null || failed);
  useReadOnShow(active, failed, () => {
    if (!reading.current) setAttempt((n) => n + 1);
  });
  useEffect(() => {
    const controller = new AbortController();
    reading.current = controller;
    (kind === "trade" ? getTrades : getLoans)(controller.signal)
      .then(
        (next) => {
          if (!controller.signal.aborted) {
            setRows(next);
            setFailed(false);
          }
        },
        () => {
          if (!controller.signal.aborted && lastRows.current === null)
            setFailed(true);
        }
      )
      .finally(() => {
        if (reading.current === controller) {
          reading.current = null;
          setReadFinished((n) => n + 1);
        }
      });
    return () => {
      controller.abort();
      if (reading.current === controller) reading.current = null;
    };
  }, [kind, attempt, changed, pulse, revision]);
  useEffect(() => {
    const moved = (event: FocusEvent) => {
      const token = restore.current;
      // Removing the old focused row may leave body focused without a new
      // collector choice. A real new focus target retires that return intent.
      if (
        token &&
        event.target !== token.node &&
        event.target !== document.body &&
        event.target !== document.documentElement
      )
        restore.current = null;
    };
    const pressed = (event: PointerEvent) => {
      const token = restore.current;
      if (
        token &&
        event.target instanceof Node &&
        !token.node?.contains(event.target)
      )
        restore.current = null;
    };
    const left = () => {
      restore.current = null;
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") left();
    };
    window.addEventListener("blur", left);
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("focusin", moved);
    document.addEventListener("pointerdown", pressed, true);
    return () => {
      window.removeEventListener("blur", left);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("focusin", moved);
      document.removeEventListener("pointerdown", pressed, true);
    };
  }, []);
  useEffect(() => {
    if (!active || selected) restore.current = null;
    if (active && previous.current && !selected)
      restore.current = { id: previous.current, node: null };
    previous.current = selected;
    if (active && !selected && rows && restore.current) {
      const link = Array.from(root.current?.querySelectorAll("a") ?? []).find(
        (a) => a.dataset.thread === restore.current?.id
      );
      restore.current.node = link ?? null;
      const details = link?.closest("details");
      if (details) details.open = true;
      link?.focus({ preventScroll: true });
      // A held refresh can move this row into Done after Back. Restore again
      // when that authoritative list arrives, instead of consuming the token
      // against the old node that React is about to remove.
      if (!reading.current) restore.current = null;
    }
  }, [active, selected, rows, readFinished]);
  const title = kind === "trade" ? "Trades" : "Loans";
  const section = (group: (typeof GROUPS)[number]) => {
    const items =
      rows?.filter((row) =>
        group === "needs_you"
          ? row.needs_you
          : !row.needs_you && row.section === group
      ) ?? [];
    if (!items.length) return null;
    const content = (
      <ul
        aria-label={`${TITLES[group]} ${title}`}
        className="m-0 list-none p-0"
      >
        {items.map((row) => (
          <li key={row.id} className="border-b border-border">
            <a
              data-thread={row.id}
              aria-current={selected === row.id ? "page" : undefined}
              href={`/${kind}s/${row.id}`}
              onClick={(event) => {
                if (
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                event.preventDefault();
                onOpen(row.id);
              }}
              className="flex min-h-tap flex-col gap-2 rounded-panel bg-surface px-4 py-3 text-text no-underline hover:bg-surface-raised"
            >
              <strong>{row.other.display_name}</strong>
              <span className="text-meta text-text-muted">
                {itemState(row)}
              </span>
              <span>
                You give {row.summary.you_give} · You get {row.summary.you_get}
                {row.summary.cash
                  ? ` · ${row.summary.cash.payer === "you" ? "You pay" : "They pay"} $${(Number(row.summary.cash.cents) / 100).toFixed(2)}`
                  : ""}
              </span>
              <span>
                {row.summary.cards
                  .map((card) => `${card.copies} ${card.name}`)
                  .join(" · ")}
              </span>
              {row.latest && (
                <span className="line-clamp-2 text-meta text-text-muted whitespace-pre-wrap wrap-anywhere">
                  {timelineText(
                    row.latest,
                    row.you_are,
                    row.other.display_name,
                    Object.fromEntries(
                      row.summary.cards.map((card) => [
                        card.edition_id,
                        card.name,
                      ])
                    )
                  )}
                </span>
              )}
              <span>
                {row.waiting && (
                  <span>↗ {waitingAction(kind, row.waiting)} </span>
                )}
                {(row.unread ?? 0) > 0 && <span>● New messages</span>}
              </span>
            </a>
          </li>
        ))}
      </ul>
    );
    return group === "done" ? (
      <details key={group}>
        <summary className="min-h-tap cursor-pointer rounded-control px-3 py-3 text-control font-medium hover:bg-surface-raised">
          Done
        </summary>
        {content}
      </details>
    ) : (
      <section key={group} aria-label={TITLES[group]}>
        <h2 className="text-heading">{TITLES[group]}</h2>
        {content}
      </section>
    );
  };
  return (
    <div ref={root} className="flex min-w-0 flex-col gap-4">
      {kind === "loan" &&
        (selected ? (
          <h2 className="text-heading">Loans</h2>
        ) : (
          <h1 className="text-display font-semibold">Loans</h1>
        ))}
      <TradingAvailability
        enabled={kind === "trade" && !selected}
        revision={`${pulse}:${changed}:${revision}:${attempt}`}
      />
      {failed && (
        <div role="status">
          Your {title} couldn't be loaded.{" "}
          <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
        </div>
      )}
      {!rows && !failed && <p role="status">Loading {title}…</p>}
      {rows?.length === 0 && <p>No {title} yet.</p>}
      {GROUPS.map(section)}
    </div>
  );
}
