import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronLeft, Ellipsis } from "lucide-react";
import { useInboxRefresh } from "../inbox/Inbox";
import { PageHeader } from "../shell/PageHeader";
import { CardImage } from "../social/FriendCollectionPage";
import type { DeckIndexEntry } from "../decks_generated";
import {
  acceptBorrowRequest,
  acceptLendOffer,
  approveExtension,
  askForMoreTime,
  cancelLoan,
  changeReturnBy,
  chooseWrittenOff,
  confirmHandover,
  confirmReturn,
  declineExtension,
  declineLoan,
  getLoan,
  getLoanSide,
  seeNotices,
  SocialError,
  startReturn,
  takeBackHandover,
  useSuggestedPicks,
  withdrawLoan,
  writeOff,
  type LoanCard,
  type LoanPickPlace,
  type LoanSide,
  type LoanStep,
  type LoanView,
} from "../social_generated";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { Menu, type MenuItem } from "../ui/Menu";
import { Select } from "../ui/Select";
import { Stepper } from "../ui/Stepper";
import { TextField } from "../ui/TextField";
import { readDecks, useBorrowDrafts } from "./BorrowDrafts";
import {
  dayAfter,
  dayText,
  lineEdition,
  lineOut,
  loanHeadline,
  loanStepMessage,
  LOANS_PATH,
  outcomeUnknown,
  today,
  waitingText,
} from "./loanText";

type Load =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "failed" }
  | { kind: "ready"; loan: LoanView; side: LoanSide };

/** A step that asks first: Decline, Withdraw and Cancel Loan end the Loan for both sides. */
type Asking = "decline" | "withdraw" | "cancel";

/** Where focus goes after the next render, when the control that had it goes away: the confirmation's own button when
 * it asks, its opener after Keep it (Decline, or ⋯ for Withdraw and Cancel Loan), and the heading after a step or a
 * refusal that reads the Loan again. */
type FocusNext =
  "ask" | "decline" | "menu" | "heading" | "count" | "date" | "decks";

const ASK: Record<
  Asking,
  { question: (other: string) => string; yes: string }
> = {
  decline: {
    question: (other) => `Decline ${other}'s request?`,
    yes: "Decline",
  },
  withdraw: {
    question: (other) => `Withdraw your request to ${other}?`,
    yes: "Withdraw request",
  },
  cancel: {
    question: () => "Cancel this Loan? Nothing stays kept for it.",
    yes: "Cancel Loan",
  },
};
// The same questions about a Lend Offer (#258).
const OFFER_ASK: typeof ASK = {
  ...ASK,
  decline: {
    question: (other) => `Decline ${other}'s offer?`,
    yes: "Decline",
  },
  withdraw: {
    question: (other) => `Withdraw your offer to ${other}?`,
    yes: "Withdraw offer",
  },
};

/**
 * One Loan's screen (social network #252, Loans verdict variant E): the headline, then "You're lending" or "You're
 * borrowing", the borrower's Deck (theirs only) and the return-by date; each line's card, set and count, and from
 * acceptance the lender's pick ("From Binder 1"). One primary button is the next step: Accept (with Decline beside
 * it); Use suggested picks while a pick is out of date (#253); Mark as handed over, or Yes, I have them. "Waiting for
 * Misty W. to answer" or "… to confirm" stands in when the other side is next. Everything else is behind ⋯: Withdraw,
 * Cancel Loan, Edit and resend and Take back my confirmation, each only when the Loan's `actions` allow it. Answering a
 * request, a stepper per line accepts part of it; a line at 0 reads "Not lent". No step tracker and no paragraphs.
 * Focus never falls to the page: asking moves it to the confirmation's button, Keep it returns it to the opener, and a
 * step that lands, or a refusal that reads the Loan again, moves it to the heading, which reads the Loan's new state.
 * Returns (#255): Record a return (lender) or Give cards back (borrower) puts a stepper on each line, every copy still
 * out to start with; the other side then confirms with Yes, they're back or Yes, I gave them back, and once the other
 * side's account is gone the side that started it finishes it with Finish return. Lines tag the copies returned and
 * those coming back. Choosing the copies moves focus to its button (Record return, Give these back), and
 * Not now moves it to the heading. Write-off (#257): the lender's Write off… puts a stepper on each line and asks once,
 * warning it can't be undone; Keep it returns focus to ⋯. The borrower then answers I still have it or It's gone for
 * the copies they hold. Lines tag the copies written off. Return-by date (#256): the
 * lender's Change return-by date and the borrower's Ask for more time open a date field in place of the primary
 * button, with focus in it, and Cancel returns focus to ⋯; the lender answers a request for more time with Approve or
 * Decline above it. Answering a request carries the date to keep, change or clear. The facts line reads "Overdue
 * since …" from the day after the date, and a Loan nobody handed over for 14 days says so once. Lend Offers (#258):
 * the borrower answers with a stepper per line, at most what was offered, and Put them in (a Deck or Unsorted); the
 * lender withdraws one from ⋯. One form or question is open at a time: opening one closes the others.
 */
export function LoanScreen({
  loanId,
  onAllLoans,
}: {
  loanId: string;
  onAllLoans: () => void;
}) {
  const drafts = useBorrowDrafts();
  // The bell and the Loans tab's badge are read again after each step and notice seen here (#259).
  const refreshInbox = useInboxRefresh();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [promised, setPromised] = useState<Map<string, number>>(new Map());
  const [asking, setAsking] = useState<Asking | null>(null);
  // Choosing a return's copies (#255): each line's count, or null while not choosing.
  const [returning, setReturning] = useState<Map<string, number> | null>(null);
  // Choosing a Write-off's copies (#257), as for a return.
  const [writing, setWriting] = useState<Map<string, number> | null>(null);
  // Changing the return-by date (lender) or asking for more time (borrower), #256: the date chosen so far.
  const [dating, setDating] = useState<{
    kind: "change" | "ask";
    value: string;
  } | null>(null);
  // The return-by date the lender answers a request with (#256): the requested one to start with.
  const [answerDate, setAnswerDate] = useState("");
  // Notices already recorded as seen on this screen (#256), so each is recorded once.
  const noticed = useRef(new Set<string>());
  // Answering a Lend Offer (#258): the borrower's Decks, and the one chosen ("" for Unsorted).
  // "failed": they couldn't be read; Retry reads them again (null).
  const [decks, setDecks] = useState<DeckIndexEntry[] | "failed" | null>(null);
  const [deckId, setDeckId] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  // One key per step until it settles, so a step whose outcome is unknown is retried safely.
  const keys = useRef(new Map<string, string>());
  const menuAnchor = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const askButton = useRef<HTMLButtonElement>(null);
  const declineButton = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<FocusNext | null>(null);
  // A step refused because the Loan moved on reads it again: the open form closes and the heading takes focus once
  // the new Loan is drawn, so focus never lands on the old headline.
  const reloading = useRef(false);
  // Put them in, answering a Lend Offer (#258): Retry after the Decks couldn't be read moves focus here.
  const deckSelect = useRef<HTMLSelectElement>(null);
  // The button that sends the copies being chosen (#255): focus goes there when choosing starts.
  const countButton = useRef<HTMLButtonElement>(null);
  // The date field of Change return-by date or Ask for more time (#256).
  const dateField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      getLoan(loanId, controller.signal),
      getLoanSide(loanId, controller.signal),
    ]).then(
      ([loan, side]) => {
        if (controller.signal.aborted) return;
        if (reloading.current) {
          reloading.current = false;
          focusNext.current = "heading";
          setAsking(null);
          setReturning(null);
          setWriting(null);
          setDating(null);
        }
        setLoad({ kind: "ready", loan, side });
        setPromised(promiseStart(loan, side));
        setAnswerDate(loan.return_by ?? "");
      },
      (cause) => {
        if (controller.signal.aborted) return;
        setLoad(
          cause instanceof SocialError && cause.status === 404
            ? { kind: "missing" }
            : { kind: "failed" }
        );
      }
    );
    return () => controller.abort();
  }, [loanId, attempt]);

  // After each render: a focus move asked for by the last press or step (FocusNext).
  useLayoutEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    const element =
      target === "ask"
        ? askButton.current
        : target === "decline"
          ? declineButton.current
          : target === "menu"
            ? menuAnchor.current?.querySelector("button")
            : target === "count"
              ? countButton.current
              : target === "date"
                ? dateField.current
                : target === "decks"
                  ? deckSelect.current
                  : heading.current;
    element?.focus();
  });

  // A time-based notice shows on this visit and is recorded as seen, so it doesn't show again (#256).
  const showing = load.kind === "ready" ? (load.loan.notices ?? []) : [];
  useEffect(() => {
    const fresh = showing.filter(
      (kind) => !noticed.current.has(`${loanId}:${kind}`)
    );
    if (fresh.length === 0) return;
    for (const kind of fresh) noticed.current.add(`${loanId}:${kind}`);
    seeNotices(loanId, { kinds: fresh }).then(refreshInbox, () => undefined);
  }, [loanId, showing.join(",")]);

  // The borrower's Decks, read once an offer waits for their answer (#258).
  const offerToAnswer =
    load.kind === "ready" &&
    load.loan.state === "offered" &&
    load.loan.role === "borrower";
  useEffect(() => {
    if (!offerToAnswer || decks !== null) return;
    let live = true;
    readDecks().then(
      (found) => live && setDecks(found),
      () => live && setDecks("failed")
    );
    return () => {
      live = false;
    };
  }, [offerToAnswer, decks]);

  const back = (
    <a
      href={LOANS_PATH}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        onAllLoans();
      }}
      className="inline-flex h-control items-center gap-1 self-start rounded-control px-2 text-control font-medium text-text-muted no-underline hover:bg-surface-raised hover:text-text phone:h-control-phone"
    >
      <Icon icon={ChevronLeft} />
      All Loans
    </a>
  );
  const frame = (title: string, children: ReactNode, actions?: ReactNode) => (
    <main className="mx-auto box-border flex max-w-3xl flex-col gap-4 px-7 py-6 phone:px-4 phone:py-4">
      {back}
      <PageHeader title={title} actions={actions} headingRef={heading} />
      {children}
    </main>
  );

  if (load.kind === "loading")
    return frame(
      "Loan",
      <p role="status" className="m-0 text-body text-text-muted">
        Loading the Loan…
      </p>
    );
  if (load.kind === "missing")
    return frame(
      "Loan not found",
      <p className="m-0 text-body text-text-muted">This Loan can't be found.</p>
    );
  if (load.kind === "failed")
    return frame(
      "Loan",
      <div className="flex flex-wrap items-center gap-3">
        <p role="status" className="m-0 text-body text-text-muted">
          This Loan couldn't be loaded.
        </p>
        <Button
          onClick={() => {
            setLoad({ kind: "loading" });
            setAttempt((n) => n + 1);
          }}
        >
          Retry
        </Button>
      </div>
    );

  const { loan, side } = load;
  const other = loan.other.display_name;
  const answering = loan.actions.includes("accept");
  const offer = loan.kind === "lend_offer";
  const asks = offer ? OFFER_ASK : ASK;
  const cardName = (editionId: string) =>
    loan.lines.find((line) => line.edition_id === editionId)?.name ?? "a card";

  /** Closes whichever form or question is open, before another opens: one at a time. */
  function closeModes() {
    setAsking(null);
    setReturning(null);
    setWriting(null);
    setDating(null);
  }
  /** Asks before a step that ends the Loan, with focus on the confirmation's button. */
  function ask(step: Asking) {
    if (busy) return;
    closeModes();
    focusNext.current = "ask";
    setAsking(step);
  }
  /** Runs one step: the answer replaces the Loan, and its own side is read again. */
  async function step(name: string, call: (key: string) => Promise<LoanView>) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    const key = keys.current.get(name) ?? crypto.randomUUID();
    keys.current.set(name, key);
    try {
      const next = await call(key);
      keys.current.delete(name);
      // The open form stays, its buttons busy, until the screen's own side is read again: the new Loan, the form
      // closing and focus on the new headline then land in one render.
      const nextSide = await getLoanSide(loanId).catch(() => side);
      focusNext.current = "heading";
      closeModes();
      setLoad({ kind: "ready", loan: next, side: nextSide });
      setPromised(promiseStart(next, nextSide));
      refreshInbox();
    } catch (cause) {
      if (!outcomeUnknown(cause)) keys.current.delete(name);
      setMessage(loanStepMessage(cause, other, cardName));
      if (cause instanceof SocialError && RELOAD.has(cause.code)) {
        reloading.current = true;
        setAttempt((n) => n + 1);
        refreshInbox();
      }
    } finally {
      setBusy(false);
    }
  }
  const body = (key: string): LoanStep => ({
    revision: loan.revision,
    idempotency_key: key,
  });
  const run: Record<Asking, () => void> = {
    decline: () =>
      void step("decline", (key) => declineLoan(loan.id, body(key))),
    withdraw: () =>
      void step("withdraw", (key) => withdrawLoan(loan.id, body(key))),
    cancel: () => void step("cancel", (key) => cancelLoan(loan.id, body(key))),
  };
  const total = [...promised.values()].reduce((sum, n) => sum + n, 0);
  const returnTotal = [...(returning?.values() ?? [])].reduce(
    (sum, n) => sum + n,
    0
  );
  const writeTotal = [...(writing?.values() ?? [])].reduce(
    (sum, n) => sum + n,
    0
  );
  const lender = loan.role === "lender";
  // A line's copies the lender may write off: those out, less those a pending return brings back (#257).
  const writable = (line: LoanCard) =>
    Math.max(
      0,
      lineOut(line) -
        Number(
          loan.pending_return?.lines.find(
            (item) => item.edition_id === line.edition_id
          )?.copies ?? "0"
        )
    );
  const awaiting = side.awaiting_choice ?? [];
  // A return the reader started that the other side, whose account is gone, can never confirm: the reader finishes
  // it alone, and nothing more moves (#255).
  const finishing =
    loan.pending_return?.you_confirmed === true &&
    loan.other.collector_id === null;
  // The handover (#253): each side confirms for its own inventory. The lender's picks must be current first.
  const handing = loan.actions.includes("confirm_handover");
  const stale =
    handing &&
    loan.role === "lender" &&
    side.picks.some((place) => place.short !== "0");

  const menu: MenuItem[] = [
    ...(loan.actions.includes("withdraw")
      ? [
          {
            label: offer ? "Withdraw offer" : "Withdraw request",
            onSelect: () => ask("withdraw"),
          },
        ]
      : []),
    ...(loan.actions.includes("take_back")
      ? [
          {
            label: "Take back my confirmation",
            onSelect: () =>
              void step("take_back", (key) =>
                takeBackHandover(loan.id, body(key))
              ),
          },
        ]
      : []),
    ...(loan.actions.includes("cancel")
      ? [{ label: "Cancel Loan", onSelect: () => ask("cancel") }]
      : []),
    ...(loan.actions.includes("write_off")
      ? [
          {
            label: "Write off…",
            onSelect: () => {
              keys.current.delete("write_off");
              closeModes();
              setWriting(
                new Map(loan.lines.map((line) => [line.edition_id, 0]))
              );
            },
          },
        ]
      : []),
    ...(loan.actions.includes("change_return_by")
      ? [
          {
            label: "Change return-by date",
            onSelect: () => {
              keys.current.delete("change_return_by");
              closeModes();
              focusNext.current = "date";
              setDating({ kind: "change", value: loan.return_by ?? "" });
            },
          },
        ]
      : []),
    ...(loan.actions.includes("ask_for_more_time")
      ? [
          {
            label: "Ask for more time",
            onSelect: () => {
              keys.current.delete("ask_for_more_time");
              closeModes();
              focusNext.current = "date";
              setDating({ kind: "ask", value: "" });
            },
          },
        ]
      : []),
    ...(loan.actions.includes("edit_and_resend") && drafts
      ? [
          {
            label: "Edit and resend",
            onSelect: () =>
              drafts.editAndResend(
                loan,
                side.deck?.id ?? null,
                menuAnchor.current?.querySelector("button") ?? null
              ),
          },
        ]
      : []),
  ];

  const facts = [
    loan.role === "lender" ? "You're lending" : "You're borrowing",
    loan.role === "borrower" &&
    loan.state !== "closed" &&
    loan.state !== "offered"
      ? `For ${side.deck?.name ?? "Unsorted"}`
      : null,
    loan.overdue_since
      ? `Overdue since ${dayText(loan.overdue_since)}`
      : loan.return_by && loan.state !== "closed"
        ? `Due back ${dayText(loan.return_by)}`
        : null,
    loan.role === "borrower" && loan.extension_to
      ? `You asked for more time, until ${dayText(loan.extension_to)}`
      : null,
  ].filter(Boolean);
  // Once either side confirmed the handover, the lender's date only moves later (#256).
  const handed = loan.you_confirmed_handover || loan.they_confirmed_handover;
  const earliest = (day: string) => (day > today() ? day : today());
  const dateMin = !dating
    ? today()
    : dating.kind === "ask"
      ? earliest(dayAfter(loan.return_by ?? today()))
      : handed && loan.return_by
        ? earliest(loan.return_by)
        : today();

  const primary =
    answering && offer ? (
      <div className="flex flex-wrap items-end gap-2">
        <Select
          ref={deckSelect}
          label="Put them in"
          value={deckId}
          onChange={(event) => setDeckId(event.target.value)}
        >
          <option value="">Unsorted</option>
          {(Array.isArray(decks) ? decks : []).map((deck) => (
            <option key={deck.id} value={deck.id}>
              {deck.name}
            </option>
          ))}
        </Select>
        <Button
          variant="primary"
          disabled={total === 0}
          aria-disabled={busy || undefined}
          onClick={() =>
            void step("accept", (key) =>
              acceptLendOffer(loan.id, {
                ...body(key),
                lines: loan.lines.map((line) => ({
                  edition_id: line.edition_id,
                  promised: String(promised.get(line.edition_id) ?? 0),
                })),
                deck_id: deckId || null,
              })
            )
          }
        >
          Accept
        </Button>
        <Button ref={declineButton} onClick={() => ask("decline")}>
          Decline
        </Button>
        {total === 0 && (
          <p className="m-0 text-meta text-text-muted">
            Take at least one card, or decline.
          </p>
        )}
        {decks === "failed" && (
          <div className="flex flex-wrap items-center gap-2">
            <p role="status" className="m-0 text-meta text-text-muted">
              Your Decks couldn't be loaded.
            </p>
            <Button
              onClick={() => {
                focusNext.current = "decks";
                setDecks(null);
              }}
            >
              Retry
            </Button>
          </div>
        )}
      </div>
    ) : answering ? (
      <div className="flex flex-wrap items-end gap-2">
        <TextField
          type="date"
          label="Return by (optional)"
          min={today()}
          value={answerDate}
          onChange={(event) => setAnswerDate(event.target.value)}
        />
        <Button
          variant="primary"
          disabled={total === 0}
          aria-disabled={busy || undefined}
          onClick={() =>
            void step("accept", (key) =>
              acceptBorrowRequest(loan.id, {
                ...body(key),
                lines: loan.lines.map((line) => ({
                  edition_id: line.edition_id,
                  promised: String(promised.get(line.edition_id) ?? 0),
                })),
                return_by: answerDate || null,
              })
            )
          }
        >
          Accept
        </Button>
        <Button ref={declineButton} onClick={() => ask("decline")}>
          Decline
        </Button>
        {total === 0 && (
          <p className="m-0 text-meta text-text-muted">
            Lend at least one card, or decline.
          </p>
        )}
      </div>
    ) : dating ? (
      <div
        role="group"
        aria-label={
          dating.kind === "change"
            ? "Change return-by date"
            : "Ask for more time"
        }
        className="flex flex-wrap items-end gap-2 rounded-panel border border-border bg-surface p-3"
      >
        <TextField
          type="date"
          ref={dateField}
          label={dating.kind === "change" ? "Return by" : "New return-by date"}
          min={dateMin}
          value={dating.value}
          onChange={(event) =>
            setDating({ ...dating, value: event.target.value })
          }
        />
        <Button
          variant="primary"
          disabled={dating.value === ""}
          aria-disabled={busy || undefined}
          onClick={() =>
            void step(
              dating.kind === "change"
                ? "change_return_by"
                : "ask_for_more_time",
              (key) =>
                dating.kind === "change"
                  ? changeReturnBy(loan.id, {
                      ...body(key),
                      return_by: dating.value,
                    })
                  : askForMoreTime(loan.id, {
                      ...body(key),
                      return_by: dating.value,
                    })
            )
          }
        >
          {dating.kind === "change" ? "Save" : "Ask"}
        </Button>
        {dating.kind === "change" && loan.return_by && (
          <Button
            aria-disabled={busy || undefined}
            onClick={() =>
              void step("change_return_by", (key) =>
                changeReturnBy(loan.id, { ...body(key), return_by: null })
              )
            }
          >
            Clear date
          </Button>
        )}
        <Button
          onClick={() => {
            focusNext.current = "menu";
            setDating(null);
          }}
        >
          Cancel
        </Button>
      </div>
    ) : writing ? (
      <div
        role="group"
        aria-label="Write off"
        className="flex flex-wrap items-center gap-2 rounded-panel border border-border bg-surface p-3"
      >
        <p className="m-0 min-w-0 flex-1 text-body">
          Write off {writeTotal === 1 ? "1 card" : `${writeTotal} cards`}? They
          leave your Collection, and this can't be undone.
        </p>
        <Button
          variant="danger"
          disabled={writeTotal === 0}
          aria-disabled={busy || undefined}
          onClick={() =>
            void step("write_off", (key) =>
              writeOff(loan.id, {
                ...body(key),
                lines: loan.lines
                  .filter((line) => (writing.get(line.edition_id) ?? 0) > 0)
                  .map((line) => ({
                    edition_id: line.edition_id,
                    quantity: String(writing.get(line.edition_id)),
                  })),
              })
            )
          }
        >
          Write off
        </Button>
        <Button
          onClick={() => {
            focusNext.current = "menu";
            setWriting(null);
          }}
        >
          Keep it
        </Button>
      </div>
    ) : returning ? (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          ref={countButton}
          variant="primary"
          disabled={returnTotal === 0}
          aria-disabled={busy || undefined}
          onClick={() =>
            void step("start_return", (key) =>
              startReturn(loan.id, {
                ...body(key),
                lines: loan.lines
                  .filter((line) => (returning.get(line.edition_id) ?? 0) > 0)
                  .map((line) => ({
                    edition_id: line.edition_id,
                    quantity: String(returning.get(line.edition_id)),
                  })),
              })
            )
          }
        >
          {lender ? "Record return" : "Give these back"}
        </Button>
        <Button
          onClick={() => {
            focusNext.current = "heading";
            setReturning(null);
          }}
        >
          Not now
        </Button>
      </div>
    ) : stale ? (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          aria-disabled={busy || undefined}
          onClick={() =>
            void step("use_suggested", (key) =>
              useSuggestedPicks(loan.id, body(key))
            )
          }
        >
          Use suggested picks
        </Button>
        <p className="m-0 text-meta text-text-muted">A pick is out of date.</p>
      </div>
    ) : loan.actions.includes("choose_written_off") ? (
      <div className="flex flex-col gap-2">
        <p className="m-0 text-body">
          Do you still have {loan.awaiting_choice === "1" ? "it" : "them"}? Kept
          cards become yours where they are.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {(["keep", "remove"] as const).map((choice) => (
            <Button
              key={choice}
              variant={choice === "keep" ? "primary" : "secondary"}
              aria-disabled={busy || undefined}
              onClick={() =>
                void step(`choose_${choice}`, (key) =>
                  chooseWrittenOff(loan.id, {
                    ...body(key),
                    choice,
                    places: awaiting.map((place) => ({
                      location_id: place.location_id ?? "",
                      edition_id: place.edition_id,
                      copies: place.copies,
                    })),
                  })
                )
              }
            >
              {loan.awaiting_choice === "1"
                ? choice === "keep"
                  ? "I still have it"
                  : "It's gone"
                : choice === "keep"
                  ? "I still have them"
                  : "They're gone"}
            </Button>
          ))}
        </div>
      </div>
    ) : loan.actions.includes("confirm_return") ? (
      <div className="flex flex-wrap items-center gap-2">
        {finishing && (
          <p className="m-0 text-body">{other} deleted their account.</p>
        )}
        <Button
          variant="primary"
          aria-disabled={busy || undefined}
          onClick={() =>
            void step("confirm_return", (key) =>
              confirmReturn(loan.id, body(key))
            )
          }
        >
          {finishing
            ? "Finish return"
            : lender
              ? "Yes, they're back"
              : "Yes, I gave them back"}
        </Button>
      </div>
    ) : handing ? (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          aria-disabled={busy || undefined}
          onClick={() =>
            void step("handover", (key) => confirmHandover(loan.id, body(key)))
          }
        >
          {loan.role === "lender" ? "Mark as handed over" : "Yes, I have them"}
        </Button>
      </div>
    ) : loan.actions.includes("start_return") ? (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          onClick={() => {
            keys.current.delete("start_return");
            closeModes();
            focusNext.current = "count";
            setReturning(
              new Map(
                loan.lines.map((line) => [line.edition_id, lineOut(line)])
              )
            );
          }}
        >
          {lender ? "Record a return" : "Give cards back"}
        </Button>
      </div>
    ) : (
      waitingText(loan) && (
        <p className="m-0 text-body text-text-muted">{waitingText(loan)}</p>
      )
    );

  return frame(
    loanHeadline(loan),
    <>
      <p className="m-0 text-meta text-text-muted">{facts.join(" · ")}</p>
      {(showing.includes("nudge_answer") ||
        showing.includes("nudge_handover")) && (
        <p role="status" className="m-0 text-body">
          {loan.state === "requested"
            ? loan.role === "lender"
              ? "Still deciding? Accept or decline this request."
              : "No answer yet. Withdraw the request if you no longer need these."
            : loan.state === "offered"
              ? loan.role === "lender"
                ? "No answer yet. Withdraw the offer to release these cards."
                : "Still want these? Accept or decline the offer."
              : "Still handing these over? Cancel to release them."}
        </p>
      )}
      {loan.actions.includes("approve_extension") && loan.extension_to && (
        <div
          role="group"
          aria-label="More time"
          className="flex flex-wrap items-center gap-2 rounded-panel border border-border bg-surface p-3"
        >
          <p className="m-0 min-w-0 flex-1 text-body">
            {other} asked for more time, until {dayText(loan.extension_to)}.
          </p>
          <Button
            variant="primary"
            aria-disabled={busy || undefined}
            onClick={() =>
              void step("approve_extension", (key) =>
                approveExtension(loan.id, body(key))
              )
            }
          >
            Approve
          </Button>
          <Button
            aria-disabled={busy || undefined}
            onClick={() =>
              void step("decline_extension", (key) =>
                declineExtension(loan.id, body(key))
              )
            }
          >
            Decline
          </Button>
        </div>
      )}
      <ul
        aria-label="Cards"
        className="m-0 list-none overflow-hidden rounded-panel border border-border bg-surface p-0"
      >
        {loan.lines.map((line) => (
          <LoanLine
            key={line.edition_id}
            loan={loan}
            line={line}
            side={side}
            answering={answering}
            value={promised.get(line.edition_id) ?? 0}
            onValue={(value) =>
              setPromised(new Map(promised).set(line.edition_id, value))
            }
            counting={
              writing
                ? {
                    value: writing.get(line.edition_id) ?? 0,
                    max: writable(line),
                    verb: "write off",
                  }
                : returning
                  ? {
                      value: returning.get(line.edition_id) ?? 0,
                      max: lineOut(line),
                      verb: "return",
                    }
                  : null
            }
            onCounting={(value) => {
              if (writing) {
                keys.current.delete("write_off");
                setWriting(new Map(writing).set(line.edition_id, value));
              } else {
                keys.current.delete("start_return");
                setReturning(new Map(returning).set(line.edition_id, value));
              }
            }}
          />
        ))}
      </ul>
      {asking ? (
        <div
          role="group"
          aria-label={asks[asking].yes}
          className="flex flex-wrap items-center gap-2 rounded-panel border border-border bg-surface p-3"
        >
          <p className="m-0 min-w-0 flex-1 text-body">
            {asks[asking].question(other)}
          </p>
          <Button
            ref={askButton}
            variant="danger"
            aria-disabled={busy || undefined}
            onClick={run[asking]}
          >
            {asks[asking].yes}
          </Button>
          <Button
            onClick={() => {
              focusNext.current = asking === "decline" ? "decline" : "menu";
              setAsking(null);
            }}
          >
            Keep it
          </Button>
        </div>
      ) : (
        primary
      )}
      <p role="alert" className="m-0 text-meta text-danger empty:hidden">
        {message}
      </p>
    </>,
    menu.length > 0 && (
      <div ref={menuAnchor}>
        <Menu
          label="More for this Loan"
          triggerClassName="inline-flex size-control shrink-0 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent p-0 text-text-muted hover:bg-surface-raised hover:text-text phone:size-tap"
          trigger={<Icon icon={Ellipsis} />}
          items={menu}
        />
      </div>
    )
  );
}

/** The copies a lender starts answering with: each line's ask, at most what they could promise now. A borrower
 * answering a Lend Offer (#258) starts with every copy offered. */
function promiseStart(loan: LoanView, side: LoanSide): Map<string, number> {
  if (loan.state === "offered")
    return new Map(
      loan.lines.map((line) => [line.edition_id, Number(line.promised)])
    );
  const available = new Map(
    side.can_promise.map((limit) => [limit.edition_id, Number(limit.available)])
  );
  return new Map(
    loan.lines.map((line) => [
      line.edition_id,
      Math.min(Number(line.requested), available.get(line.edition_id) ?? 0),
    ])
  );
}

/** The refusals that mean the Loan or its picks moved on: the screen reads them again. */
const RELOAD = new Set([
  "LOAN_CHANGED",
  "STEP_NOT_ALLOWED",
  "CHOICE_CHANGED",
  "PICKS_OUT_OF_DATE",
  "PICKS_UP_TO_DATE",
]);

/** Where the lender takes a line's copies from: "From Binder 1", or each place with its count. */
function pickText(places: LoanPickPlace[], editionId: string): string | null {
  const found = places.filter((place) => place.edition_id === editionId);
  if (found.length === 0) return null;
  if (found.length === 1) return `From ${found[0].name}`;
  return `From ${found.map((place) => `${place.name} (${place.copies})`).join(" · ")}`;
}

/**
 * Each out-of-date pick of a line (#253), with where the suggested picks take the copies from: "Binder 2 has only
 * 1 Iono now", "Binder 2 has no Iono now". Read from the lender's own side; the borrower never sees a Location.
 */
function staleText(
  side: LoanSide,
  line: LoanCard
): { key: string; text: string }[] {
  return side.picks
    .filter(
      (place) => place.edition_id === line.edition_id && place.short !== "0"
    )
    .map((place, index) => {
      const left = Number(place.copies) - Number(place.short);
      // Keyed by the Location: two Locations can share a leaf name.
      return {
        key: place.location_id ?? `place-${index}`,
        text:
          left > 0
            ? `${place.name} has only ${left} ${line.name} now`
            : `${place.name} has no ${line.name} now`,
      };
    });
}

function LoanLine({
  loan,
  line,
  side,
  answering,
  value,
  onValue,
  counting,
  onCounting,
}: {
  loan: LoanView;
  line: LoanCard;
  side: LoanSide;
  answering: boolean;
  value: number;
  onValue: (value: number) => void;
  /** While choosing a return's (#255) or a Write-off's (#257) copies: this line's count, its most and the verb. */
  counting: { value: number; max: number; verb: "return" | "write off" } | null;
  onCounting: (value: number) => void;
}) {
  const edition = lineEdition(line);
  const requested = Number(line.requested);
  const available = Number(
    side.can_promise.find((limit) => limit.edition_id === line.edition_id)
      ?.available ?? 0
  );
  const accepted =
    loan.state !== "requested" &&
    loan.lines.some((item) => item.promised !== "0");
  const pick =
    loan.role === "lender" &&
    (loan.state === "accepted" || loan.state === "handed_over")
      ? pickText(side.picks, line.edition_id)
      : null;
  const stale = loan.role === "lender" ? staleText(side, line) : [];
  const suggested = stale.length
    ? pickText(side.suggested, line.edition_id)
    : null;
  // Returns (#255): copies back in complete returns, and those in the return waiting for a confirmation.
  const returned = Number(line.returned ?? "0");
  const coming = Number(
    loan.pending_return?.lines.find(
      (item) => item.edition_id === line.edition_id
    )?.copies ?? "0"
  );
  const writtenOff = Number(line.written_off);
  let count: ReactNode;
  if (counting !== null)
    count = (
      <div className="flex flex-col items-end gap-1 phone:items-start">
        <Stepper
          label={`Copies of ${line.name}, ${edition} to ${counting.verb}`}
          value={counting.value}
          min={0}
          max={counting.max}
          onChange={onCounting}
        />
        <span className="text-meta text-text-muted">
          {counting.max === 0 ? "None out" : `of ${counting.max} out`}
        </span>
      </div>
    );
  else if (answering && loan.kind === "lend_offer")
    count = (
      <div className="flex flex-col items-end gap-1 phone:items-start">
        <Stepper
          label={`Copies of ${line.name}, ${edition} to borrow`}
          value={value}
          min={0}
          max={requested}
          onChange={onValue}
        />
        <span className="text-meta text-text-muted">
          {value === 0 ? "Not borrowed" : `of ${requested} offered`}
        </span>
      </div>
    );
  else if (answering)
    count = (
      <div className="flex flex-col items-end gap-1 phone:items-start">
        <Stepper
          label={`Copies of ${line.name}, ${edition} to lend`}
          value={value}
          min={0}
          max={Math.min(requested, available)}
          onChange={onValue}
        />
        <span className="text-meta text-text-muted">
          {value === 0
            ? "Not lent"
            : `of ${requested} asked${available < requested ? ` · you have ${available}` : ""}`}
        </span>
      </div>
    );
  else if (accepted && line.promised === "0")
    count = <span className="text-meta text-text-muted">Not lent</span>;
  else
    count = (
      <span className="text-heading font-semibold tabular-nums">
        {accepted ? line.promised : line.requested}
        {accepted && line.promised !== line.requested && (
          <span className="text-meta font-normal text-text-muted">
            {" "}
            of {line.requested}{" "}
            {loan.kind === "lend_offer" ? "offered" : "asked"}
          </span>
        )}
      </span>
    );
  return (
    <li className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 last:border-b-0 phone:grid-cols-[2.5rem_minmax(0,1fr)]">
      <CardImage url={line.image_url} />
      <div className="min-w-0">
        <p className="m-0 text-body font-medium wrap-anywhere">{line.name}</p>
        <p className="m-0 text-meta text-text-muted wrap-anywhere">{edition}</p>
        {pick && (
          <p className="m-0 text-meta text-text-muted wrap-anywhere">{pick}</p>
        )}
        {stale.map(({ key, text }) => (
          <p key={key} className="m-0 text-meta text-warning wrap-anywhere">
            {text}
          </p>
        ))}
        {suggested && (
          <p className="m-0 text-meta text-text-muted wrap-anywhere">
            Suggested: {suggested}
          </p>
        )}
        {returned > 0 && (
          <p className="m-0 text-meta text-text-muted wrap-anywhere">
            {returned} returned
          </p>
        )}
        {coming > 0 && (
          <p className="m-0 text-meta text-text-muted wrap-anywhere">
            {coming} coming back
          </p>
        )}
        {writtenOff > 0 && (
          <p className="m-0 text-meta text-text-muted wrap-anywhere">
            {writtenOff} written off
          </p>
        )}
      </div>
      <div className="min-w-0 text-right phone:col-start-2 phone:text-left">
        {count}
      </div>
    </li>
  );
}
