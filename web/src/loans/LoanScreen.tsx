import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronLeft, Ellipsis } from "lucide-react";
import { PageHeader } from "../shell/PageHeader";
import { CardImage } from "../social/FriendCollectionPage";
import {
  acceptBorrowRequest,
  cancelLoan,
  confirmHandover,
  declineLoan,
  getLoan,
  getLoanSide,
  SocialError,
  takeBackHandover,
  useSuggestedPicks,
  withdrawLoan,
  type LoanCard,
  type LoanPickPlace,
  type LoanSide,
  type LoanStep,
  type LoanView,
} from "../social_generated";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { Menu, type MenuItem } from "../ui/Menu";
import { Stepper } from "../ui/Stepper";
import { useBorrowDrafts } from "./BorrowDrafts";
import {
  dayText,
  lineEdition,
  loanHeadline,
  loanStepMessage,
  LOANS_PATH,
  outcomeUnknown,
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
type FocusNext = "ask" | "decline" | "menu" | "heading";

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
 */
export function LoanScreen({
  loanId,
  onAllLoans,
}: {
  loanId: string;
  onAllLoans: () => void;
}) {
  const drafts = useBorrowDrafts();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [promised, setPromised] = useState<Map<string, number>>(new Map());
  const [asking, setAsking] = useState<Asking | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  // One key per step until it settles, so a step whose outcome is unknown is retried safely.
  const keys = useRef(new Map<string, string>());
  const menuAnchor = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const askButton = useRef<HTMLButtonElement>(null);
  const declineButton = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<FocusNext | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      getLoan(loanId, controller.signal),
      getLoanSide(loanId, controller.signal),
    ]).then(
      ([loan, side]) => {
        if (controller.signal.aborted) return;
        setLoad({ kind: "ready", loan, side });
        setPromised(promiseStart(loan, side));
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
            : heading.current;
    element?.focus();
  });

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
  const cardName = (editionId: string) =>
    loan.lines.find((line) => line.edition_id === editionId)?.name ?? "a card";

  /** Asks before a step that ends the Loan, with focus on the confirmation's button. */
  function ask(step: Asking) {
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
      focusNext.current = "heading";
      setAsking(null);
      const nextSide = await getLoanSide(loanId).catch(() => side);
      setLoad({ kind: "ready", loan: next, side: nextSide });
      setPromised(promiseStart(next, nextSide));
    } catch (cause) {
      if (!outcomeUnknown(cause)) keys.current.delete(name);
      setMessage(loanStepMessage(cause, other, cardName));
      if (cause instanceof SocialError && RELOAD.has(cause.code)) {
        focusNext.current = "heading";
        setAsking(null);
        setAttempt((n) => n + 1);
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
  // The handover (#253): each side confirms for its own inventory. The lender's picks must be current first.
  const handing = loan.actions.includes("confirm_handover");
  const stale =
    handing &&
    loan.role === "lender" &&
    side.picks.some((place) => place.short !== "0");

  const menu: MenuItem[] = [
    ...(loan.actions.includes("withdraw")
      ? [{ label: "Withdraw request", onSelect: () => ask("withdraw") }]
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
    loan.role === "borrower" && loan.state !== "closed"
      ? `For ${side.deck?.name ?? "Unsorted"}`
      : null,
    loan.return_by && loan.state !== "closed"
      ? `Due back ${dayText(loan.return_by)}`
      : null,
  ].filter(Boolean);

  const primary = answering ? (
    <div className="flex flex-wrap items-center gap-2">
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
  ) : (
    waitingText(loan) && (
      <p className="m-0 text-body text-text-muted">{waitingText(loan)}</p>
    )
  );

  return frame(
    loanHeadline(loan),
    <>
      <p className="m-0 text-meta text-text-muted">{facts.join(" · ")}</p>
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
          />
        ))}
      </ul>
      {asking ? (
        <div
          role="group"
          aria-label={ASK[asking].yes}
          className="flex flex-wrap items-center gap-2 rounded-panel border border-border bg-surface p-3"
        >
          <p className="m-0 min-w-0 flex-1 text-body">
            {ASK[asking].question(other)}
          </p>
          <Button
            ref={askButton}
            variant="danger"
            aria-disabled={busy || undefined}
            onClick={run[asking]}
          >
            {ASK[asking].yes}
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

/** The copies a lender starts answering with: each line's ask, at most what they could promise now. */
function promiseStart(loan: LoanView, side: LoanSide): Map<string, number> {
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
  "PICKS_OUT_OF_DATE",
  "PICKS_UP_TO_DATE",
]);

/** "Waiting for Misty W. to answer" or "… to confirm" while the other side is next, else null. */
function waitingText(loan: LoanView): string | null {
  const other = loan.other.display_name;
  if (loan.state === "requested" && loan.role === "borrower")
    return `Waiting for ${other} to answer`;
  if (
    loan.state === "accepted" &&
    loan.you_confirmed_handover &&
    !loan.they_confirmed_handover
  )
    return `Waiting for ${other} to confirm`;
  return null;
}

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
function staleText(side: LoanSide, line: LoanCard): string[] {
  return side.picks
    .filter(
      (place) => place.edition_id === line.edition_id && place.short !== "0"
    )
    .map((place) => {
      const left = Number(place.copies) - Number(place.short);
      return left > 0
        ? `${place.name} has only ${left} ${line.name} now`
        : `${place.name} has no ${line.name} now`;
    });
}

function LoanLine({
  loan,
  line,
  side,
  answering,
  value,
  onValue,
}: {
  loan: LoanView;
  line: LoanCard;
  side: LoanSide;
  answering: boolean;
  value: number;
  onValue: (value: number) => void;
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
  let count: ReactNode;
  if (answering)
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
            of {line.requested} asked
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
        {stale.map((text) => (
          <p key={text} className="m-0 text-meta text-warning wrap-anywhere">
            {text}
          </p>
        ))}
        {suggested && (
          <p className="m-0 text-meta text-text-muted wrap-anywhere">
            Suggested: {suggested}
          </p>
        )}
      </div>
      <div className="min-w-0 text-right phone:col-start-2 phone:text-left">
        {count}
      </div>
    </li>
  );
}
