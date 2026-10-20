import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Bell } from "lucide-react";
import {
  clearInbox,
  getInbox,
  markInboxRead,
  type InboxView,
} from "../social_generated";
import { tradePath } from "../trades/tradeListModel";
import {
  tradeSubline,
  tradeUpdateText,
  tradeWaitingLabel,
} from "../trades/tradeText";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../ui/Icon";
import {
  loanCardNames,
  loanPath,
  updateText,
  waitingLabel,
} from "../loans/loanText";
import { inboxTime } from "./inboxTime";

/**
 * The inbox (social network #259, spec "Inbox derivation", variant E): the bell in the header, with a badge counting
 * the Loans waiting on the collector, opens it from any page. **Waiting on you** lists one line per Loan ("Kim · Hand
 * over"), each saying how long it has waited, from when the Loan reached that step ("2 days ago"), then **Earlier**
 * lists the updates with a single **Clear**, each saying when it happened ("3 hours ago", "Oct 3"; owner's decision,
 * 2026-10-16). Each line opens its Loan. The Loans tab's badge counts the same Loans; the
 * Friends button's counts Friend Requests (FriendsDrawer).
 *
 * Trades (Trading #273, prototype inbox drawer): Waiting on you lists one line per Trade waiting on the collector first
 * ("Kim · Confirm swap"), then the Loans' lines as before; Earlier lists the Trade updates among the Loan updates,
 * newest first ("Kim accepted your Trade Proposal"), and one Clear clears both. Each opens its Trade. The bell counts
 * Loans and Trades; the Trades tab's badge counts the Trades. With no Trades the drawer is exactly the Loans' drawer.
 *
 * The shell provides it; the desktop header and the phone headers (the shell's and Collection's own) draw the bell.
 * It is read when the shell starts, when the drawer opens and closes, when the window regains focus and after a change
 * elsewhere (`useInboxRefresh`: a Loan step, a Friend command); nothing polls. Opening the drawer marks the updates it
 * shows read; they are still drawn as new until it closes. Clear dismisses the updates it showed, and an update
 * that arrived since stays.
 *
 * Focus: a Loan opened from the drawer takes focus on its heading once it is drawn (`useOpenedFromInbox`), since the
 * bell that opened the drawer may be hidden by then (Collection's phone header). A Friend command that cancels Loans
 * and Trades (`useNoteLoansChanged`) also has the Loans list and the Trades list read them again (`useLoansChanged`,
 * `useTradesChanged`, Trading #274).
 */
type InboxApi = {
  open: (opener: RefObject<HTMLElement | null>) => void;
  isOpen: boolean;
  /** Loans waiting on the collector, for the bell's and the Loans tab's badges; 0 until the first read. */
  waiting: number;
  /** Trades waiting on the collector (Trading #273), for the bell's and the Trades tab's badges; 0 until the first
   * read. */
  tradesWaiting: number;
  refresh: () => void;
  /** How many times Loans and Trades were changed from outside their tabs (a Friend command), for the lists to read
   * again. */
  loansChanged: number;
  noteLoansChanged: () => void;
  /** Whether the drawer just opened this Loan or Trade; true once, for its screen to focus its heading. */
  takeOpened: (id: string) => boolean;
};

const InboxContext = createContext<InboxApi | null>(null);

/** Reads the inbox again after a change made elsewhere (a Loan or Trade step, a Friend command); nothing outside the
 * shell. */
export function useInboxRefresh(): () => void {
  return useContext(InboxContext)?.refresh ?? (() => {});
}

/** After a change that may have cancelled Loans and Trades outside their tabs (Remove Friend, Block): reads the inbox
 * again, and has the Loans list and the Trades list read again. */
export function useNoteLoansChanged(): () => void {
  return useContext(InboxContext)?.noteLoansChanged ?? (() => {});
}

/** A count that moves on each such change, for the Loans list to read again; 0 outside the shell. */
export function useLoansChanged(): number {
  return useContext(InboxContext)?.loansChanged ?? 0;
}

/** The same count, for the Trades list to read again (Trading #274); 0 outside the shell. */
export function useTradesChanged(): number {
  return useContext(InboxContext)?.loansChanged ?? 0;
}

/** Whether the inbox's drawer just opened this Loan or Trade, true once; false outside the shell. */
export function useOpenedFromInbox(): (id: string) => boolean {
  return useContext(InboxContext)?.takeOpened ?? (() => false);
}

/** The Loans waiting on the collector, for the Loans tab's badge; 0 outside the shell. */
export function useInboxWaiting(): number {
  return useContext(InboxContext)?.waiting ?? 0;
}

/** The Trades waiting on the collector, for the Trades tab's badge (Trading #273); 0 outside the shell. */
export function useInboxTradesWaiting(): number {
  return useContext(InboxContext)?.tradesWaiting ?? 0;
}

type Load =
  { kind: "loading" } | { kind: "ready"; view: InboxView } | { kind: "failed" };

/** An answer with the inbox's Loan lists, so an unexpected body reads as a failed read rather than breaking the shell.
 * Trade lists an answer lacks read as empty. */
function inboxView(body: unknown): InboxView | null {
  const view = body as InboxView | null;
  if (!view || !Array.isArray(view.waiting) || !Array.isArray(view.updates))
    return null;
  return {
    ...view,
    trade_waiting: Array.isArray(view.trade_waiting) ? view.trade_waiting : [],
    trade_updates: Array.isArray(view.trade_updates) ? view.trade_updates : [],
  };
}

export function InboxProvider({
  onOpenLoan,
  onOpenTrade,
  children,
}: {
  /** Opens one Loan (/loans/<id>). */
  onOpenLoan: (id: string) => void;
  /** Opens one Trade (/trades/<id>, Trading #273). */
  onOpenTrade: (id: string) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const opener = useRef<HTMLElement | null>(null);
  const reads = useRef(0);
  const [loansChanged, setLoansChanged] = useState(0);
  // The Loan or Trade the drawer last opened, until its screen takes it.
  const opened = useRef<string | null>(null);

  const show = useCallback((body: unknown) => {
    const view = inboxView(body);
    setLoad((current) =>
      view
        ? { kind: "ready", view }
        : current.kind === "ready"
          ? current
          : { kind: "failed" }
    );
  }, []);

  const refresh = useCallback(() => {
    const read = ++reads.current;
    getInbox()
      .then((body) => {
        if (read === reads.current) show(body);
      })
      .catch(() => {
        if (read === reads.current)
          setLoad((current) =>
            current.kind === "ready" ? current : { kind: "failed" }
          );
      });
  }, [show]);

  useEffect(() => {
    refresh();
    const onFocus = () => refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const waiting = load.kind === "ready" ? load.view.waiting.length : 0;
  const tradesWaiting =
    load.kind === "ready" ? load.view.trade_waiting.length : 0;
  return (
    <InboxContext.Provider
      value={{
        open: (from) => {
          opener.current = from.current;
          setOpen(true);
          refresh();
        },
        isOpen: open,
        waiting,
        tradesWaiting,
        refresh,
        loansChanged,
        noteLoansChanged: () => {
          setLoansChanged((n) => n + 1);
          refresh();
        },
        takeOpened: (id) => {
          if (opened.current !== id) return false;
          opened.current = null;
          return true;
        },
      }}
    >
      {children}
      <InboxDialog
        open={open}
        load={load}
        opener={opener}
        onClose={() => {
          setOpen(false);
          refresh();
        }}
        onCleared={(body) => {
          // A newer read already started wins over this answer.
          ++reads.current;
          show(body);
        }}
        onOpenLoan={(id) => {
          opened.current = id;
          onOpenLoan(id);
        }}
        onOpenTrade={(id) => {
          opened.current = id;
          onOpenTrade(id);
        }}
      />
    </InboxContext.Provider>
  );
}

/** "Inbox", or "Inbox, 2 waiting" when Loans or Trades wait on the collector. */
function inboxName(waiting: number): string {
  return waiting ? `Inbox, ${waiting} waiting` : "Inbox";
}

/** "Loans, 1 needs you", "Loans, 2 need you"; undefined when nothing does, so the tab's name is its label. */
export function loansTabName(waiting: number): string | undefined {
  if (!waiting) return undefined;
  return `Loans, ${waiting} ${waiting === 1 ? "needs" : "need"} you`;
}

/** "Trades, 1 needs you", "Trades, 2 need you"; undefined when nothing does, so the tab's name is its label. */
export function tradesTabName(waiting: number): string | undefined {
  if (!waiting) return undefined;
  return `Trades, ${waiting} ${waiting === 1 ? "needs" : "need"} you`;
}

/** A count drawn over a header button or a tab's icon; hidden from assistive technology, which reads the name. */
export function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      aria-hidden="true"
      className="absolute top-0 right-0 box-border inline-block h-4.5 min-w-4.5 rounded-round bg-accent px-1 text-center text-micro leading-4.5 font-bold text-on-accent tabular-nums"
    >
      {count}
    </span>
  );
}

/** The header's bell: 32 px on desktop, a 44 px tap area on a phone. Nothing outside the shell. */
export function InboxButton({ phone = false }: { phone?: boolean }) {
  const inbox = useContext(InboxContext);
  const ref = useRef<HTMLButtonElement>(null);
  if (!inbox) return null;
  return (
    <button
      ref={ref}
      type="button"
      aria-label={inboxName(inbox.waiting + inbox.tradesWaiting)}
      aria-haspopup="dialog"
      aria-expanded={inbox.isOpen}
      onClick={() => inbox.open(ref)}
      className={`relative shrink-0 cursor-pointer items-center justify-center rounded-round border-0 bg-transparent p-0 text-text-muted hover:text-text ${
        phone ? "hidden size-tap phone:inline-flex" : "inline-flex size-8"
      }`}
    >
      <Icon icon={Bell} size={20} />
      <Badge count={inbox.waiting + inbox.tradesWaiting} />
    </button>
  );
}

const LINE =
  "flex min-h-tap flex-col justify-center rounded-control px-2 py-2 text-text no-underline hover:bg-surface-raised";

/** One update under Earlier, a Loan's or a Trade's, as the drawer draws it. */
type EarlierLine = {
  id: string;
  text: string;
  at: string;
  read: boolean;
  href: string;
  open: () => void;
};

/**
 * The Loan updates and the Trade updates as one list, newest first. Each list is newest first already, and a Loan
 * update goes first at the same time, so with no Trade updates the list is the Loan updates as they came.
 */
function earlierLines(
  view: InboxView,
  onOpenLoan: (id: string) => void,
  onOpenTrade: (id: string) => void
): EarlierLine[] {
  const loans: EarlierLine[] = view.updates.map((update) => ({
    id: update.id,
    text: updateText(update),
    at: update.at,
    read: update.read,
    href: loanPath(update.loan_id),
    open: () => onOpenLoan(update.loan_id),
  }));
  const trades: EarlierLine[] = view.trade_updates.map((update) => ({
    id: update.id,
    text: tradeUpdateText(update),
    at: update.at,
    read: update.read,
    href: tradePath(update.trade_id),
    open: () => onOpenTrade(update.trade_id),
  }));
  const merged: EarlierLine[] = [];
  let i = 0;
  let j = 0;
  while (i < loans.length || j < trades.length) {
    const takeLoan =
      j >= trades.length ||
      (i < loans.length && Date.parse(loans[i].at) >= Date.parse(trades[j].at));
    merged.push(takeLoan ? loans[i++] : trades[j++]);
  }
  return merged;
}

function InboxDialog({
  open,
  load,
  opener,
  onClose,
  onCleared,
  onOpenLoan,
  onOpenTrade,
}: {
  open: boolean;
  load: Load;
  opener: RefObject<HTMLElement | null>;
  onClose: () => void;
  onCleared: (body: unknown) => void;
  onOpenLoan: (id: string) => void;
  onOpenTrade: (id: string) => void;
}) {
  const base = useId();
  const earlier = useRef<HTMLHeadingElement>(null);
  const [status, setStatus] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  // The updates this opening showed unread: marked read once each, and still drawn as new until the drawer closes,
  // whatever a read in the meantime says.
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const view = load.kind === "ready" ? load.view : null;
  // "3 hours ago" is as of this drawing; nothing redraws it while the drawer stays open.
  const now = Date.now();
  const earlierList = view
    ? earlierLines(
        view,
        (id) => {
          close();
          onOpenLoan(id);
        },
        (id) => {
          close();
          onOpenTrade(id);
        }
      )
    : [];
  const toMark = open
    ? earlierList
        .filter((update) => !update.read && !fresh.has(update.id))
        .map((update) => update.id)
    : [];
  useEffect(() => {
    if (toMark.length === 0) return;
    setFresh((current) => new Set([...current, ...toMark]));
    markInboxRead({ ids: toMark }).catch(() => undefined);
  }, [toMark.join(",")]);

  function close() {
    setFresh(new Set());
    setStatus("");
    setProblem("");
    onClose();
  }

  /** A plain click opens the line here and closes the drawer; a modified click is the browser's. */
  function follow(event: MouseEvent, open: () => void) {
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    open();
  }
  function openLoan(event: MouseEvent, id: string) {
    follow(event, () => {
      close();
      onOpenLoan(id);
    });
  }
  function openTrade(event: MouseEvent, id: string) {
    follow(event, () => {
      close();
      onOpenTrade(id);
    });
  }

  async function clear() {
    if (!view || busy || earlierList.length === 0) return;
    setBusy(true);
    setStatus("");
    setProblem("");
    try {
      onCleared(
        await clearInbox({ ids: earlierList.map((update) => update.id) })
      );
      setStatus("Cleared.");
      earlier.current?.focus();
    } catch {
      setProblem("Couldn't clear. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Inbox"
      closeLabel="Close Inbox"
      side="right"
      returnFocus={opener}
    >
      {open && (
        <div className="flex flex-col gap-4">
          {load.kind === "loading" && (
            <p className="m-0 text-meta text-text-muted">Loading…</p>
          )}
          {load.kind === "failed" && (
            <p role="alert" className="m-0 text-meta text-danger">
              Your inbox is temporarily unavailable. Please retry.
            </p>
          )}
          {view && (
            <section
              aria-labelledby={`${base}-waiting`}
              className="flex flex-col gap-1"
            >
              <h3
                id={`${base}-waiting`}
                className="m-0 text-meta font-semibold text-text-muted"
              >
                Waiting on you
              </h3>
              {view.waiting.length + view.trade_waiting.length === 0 ? (
                <p className="m-0 py-1 text-meta text-text-muted">
                  Nothing is waiting on you.
                </p>
              ) : (
                <ul className="m-0 flex list-none flex-col p-0">
                  {view.trade_waiting.map((trade) => (
                    <li key={trade.id}>
                      <a
                        href={tradePath(trade.id)}
                        onClick={(event) => openTrade(event, trade.id)}
                        className={LINE}
                      >
                        <span className="text-body font-semibold wrap-anywhere">
                          {trade.other.display_name} ·{" "}
                          {tradeWaitingLabel(trade)}
                        </span>
                        <span className="text-meta text-text-muted wrap-anywhere">
                          {tradeSubline(trade)}
                        </span>{" "}
                        <time
                          dateTime={trade.since}
                          className="text-meta font-normal text-text-muted"
                        >
                          {inboxTime(trade.since, now)}
                        </time>
                      </a>
                    </li>
                  ))}
                  {view.waiting.map((loan) => (
                    <li key={loan.id}>
                      <a
                        href={loanPath(loan.id)}
                        onClick={(event) => openLoan(event, loan.id)}
                        className={LINE}
                      >
                        <span className="text-body font-semibold wrap-anywhere">
                          {loan.other.display_name} · {waitingLabel(loan)}
                        </span>
                        <span className="text-meta text-text-muted wrap-anywhere">
                          {loanCardNames(loan)}
                        </span>{" "}
                        <time
                          dateTime={loan.since}
                          className="text-meta font-normal text-text-muted"
                        >
                          {inboxTime(loan.since, now)}
                        </time>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {view && (
            <section
              aria-labelledby={`${base}-earlier`}
              className="flex flex-col gap-1"
            >
              <div className="flex min-h-tap items-center gap-2">
                <h3
                  id={`${base}-earlier`}
                  ref={earlier}
                  tabIndex={-1}
                  className="m-0 min-w-0 flex-1 text-meta font-semibold text-text-muted outline-none"
                >
                  Earlier
                </h3>
                {earlierList.length > 0 && (
                  <Button
                    aria-disabled={busy || undefined}
                    onClick={() => void clear()}
                  >
                    Clear
                  </Button>
                )}
              </div>
              {earlierList.length === 0 ? (
                <p className="m-0 py-1 text-meta text-text-muted">
                  No updates.
                </p>
              ) : (
                <ul className="m-0 flex list-none flex-col p-0">
                  {earlierList.map((update) => {
                    const isNew = !update.read || fresh.has(update.id);
                    return (
                      <li key={update.id}>
                        <a
                          href={update.href}
                          onClick={(event) => follow(event, update.open)}
                          className={`${LINE} ${isNew ? "font-semibold" : ""}`}
                        >
                          <span className="text-body wrap-anywhere">
                            {isNew && <span className="sr-only">New: </span>}
                            {update.text}
                          </span>{" "}
                          <time
                            dateTime={update.at}
                            className="text-meta font-normal text-text-muted"
                          >
                            {inboxTime(update.at, now)}
                          </time>
                        </a>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}
          <p
            role="status"
            className="m-0 text-meta text-text-muted empty:hidden"
          >
            {status}
          </p>
          {problem && (
            <p role="alert" className="m-0 text-meta text-danger">
              {problem}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
