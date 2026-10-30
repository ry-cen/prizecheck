import { ArrowUpRight, ArrowDownLeft, ChevronDown } from "lucide-react";
import { Avatar } from "../ui/Avatar";
import { Icon } from "../ui/Icon";
import { Pill } from "../ui/Pill";
import { useFirstReadSettled, useReadOnShow } from "../shell/keptRead";
import {
  useEffect,
  useId,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useLoansChanged } from "../inbox/Inbox";
import { PageHeader } from "../shell/PageHeader";
import { CardImage } from "../social/FriendCollectionPage";
import { getLoans, type LoanView, type LoansView } from "../social_generated";
import { Button } from "../ui/Button";
import { LoanScreen } from "./LoanScreen";
import {
  loanCardNames,
  loanHeadline,
  loanLines,
  loanPath,
  loanStatus,
} from "./loanText";

type Props = {
  /** The Loan the address names (/loans/<id>), or null for the list. */
  loanId: string | null;
  active: boolean;
  onOpenLoan: (id: string) => void;
  onAllLoans: () => void;
};

/**
 * The Loans tab (social network #252, spec "Web screens", Loans verdict variant E): /loans lists the collector's Loans
 * in **Needs you**, **Out now** and **Pending**, with **History** folded away; /loans/<id> is one Loan's screen
 * (LoanScreen). The tab's badge counts the Loans in Needs you, read through the inbox (#259). The list is read again
 * after a Friend command that may have cancelled Loans (#260, `useLoansChanged`).
 */
export function LoansPage({ active, loanId, onOpenLoan, onAllLoans }: Props) {
  if (loanId)
    return <LoanScreen key={loanId} loanId={loanId} onAllLoans={onAllLoans} />;
  return <LoansList active={active} onOpenLoan={onOpenLoan} />;
}

type Load =
  { kind: "loading" } | { kind: "failed" } | { kind: "ready"; view: LoansView };

const SECTIONS = [
  { id: "needs_you", title: "Needs you" },
  { id: "out_now", title: "Out now" },
  { id: "pending", title: "Pending" },
] as const;

function LoansList({
  active,
  onOpenLoan,
}: {
  active: boolean;
  onOpenLoan: (id: string) => void;
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const changed = useLoansChanged();
  useFirstReadSettled(load.kind !== "loading");
  useReadOnShow(active, load.kind === "failed", () => setAttempt((n) => n + 1));

  useEffect(() => {
    const controller = new AbortController();
    getLoans(controller.signal).then(
      (view) => {
        if (!controller.signal.aborted) setLoad({ kind: "ready", view });
      },
      () => {
        if (!controller.signal.aborted)
          setLoad((current) =>
            current.kind === "ready" ? current : { kind: "failed" }
          );
      }
    );
    return () => controller.abort();
  }, [attempt, changed]);

  const frame = (children: ReactNode) => (
    <main className="mx-auto box-border flex w-full min-w-0 max-w-5xl flex-col gap-6 px-7 py-7 phone:px-4 phone:py-5">
      <PageHeader title="Loans" />
      {children}
    </main>
  );
  if (load.kind === "loading")
    return frame(
      <p
        role="status"
        className="m-0 rounded-panel border border-border bg-surface p-5 text-body text-text-muted"
      >
        Loading Loans…
      </p>
    );
  if (load.kind === "failed")
    return frame(
      <div className="flex flex-wrap items-center gap-3">
        <p
          role="status"
          className="m-0 rounded-panel border border-border bg-surface p-5 text-body text-text-muted"
        >
          Your Loans couldn't be loaded.
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
  const { loans } = load.view;
  if (loans.length === 0)
    return frame(
      <p className="m-0 rounded-panel border border-border bg-surface p-5 text-body text-text-muted">
        No Loans yet. Ask a Friend to lend you cards from the Want List, a
        card's details or their Collection.
      </p>
    );
  const history = loans.filter((loan) => loan.section === "history");
  return frame(
    <>
      {SECTIONS.map(({ id, title }) => {
        const rows = loans.filter((loan) => loan.section === id);
        return rows.length ? (
          <LoanSection
            key={id}
            title={title}
            loans={rows}
            onOpenLoan={onOpenLoan}
          />
        ) : null;
      })}
      {history.length > 0 && (
        <details className="group flex flex-col gap-3 border-t border-border pt-4">
          <summary className="inline-flex min-h-control cursor-pointer items-center gap-2 rounded-control text-heading font-semibold phone:min-h-tap">
            <Icon icon={ChevronDown} className="group-open:rotate-180" />
            History
            <span className="text-meta font-normal text-text-muted tabular-nums">
              {history.length}
            </span>
          </summary>
          <LoanRows loans={history} onOpenLoan={onOpenLoan} label="History" />
        </details>
      )}
    </>
  );
}

function LoanSection({
  title,
  loans,
  onOpenLoan,
}: {
  title: string;
  loans: LoanView[];
  onOpenLoan: (id: string) => void;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 id={headingId} className="m-0 text-heading font-semibold">
          {title}
        </h2>
        <span className="text-meta text-text-muted tabular-nums">
          {loans.length}
        </span>
      </div>
      <LoanRows loans={loans} onOpenLoan={onOpenLoan} label={title} />
    </section>
  );
}

/** Rows carry no buttons (variant E): each is one link to its Loan. */
function LoanRows({
  loans,
  onOpenLoan,
  label,
}: {
  loans: LoanView[];
  onOpenLoan: (id: string) => void;
  label: string;
}) {
  return (
    <ul
      aria-label={label}
      className="m-0 list-none overflow-hidden rounded-panel border border-border bg-surface p-0"
    >
      {loans.map((loan) => {
        const status = loanStatus(loan);
        return (
          <li key={loan.id} className="border-b border-border last:border-b-0">
            <a
              href={loanPath(loan.id)}
              onClick={(event: MouseEvent) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                event.preventDefault();
                onOpenLoan(loan.id);
              }}
              className="grid min-h-tap grid-cols-[auto_3.5rem_minmax(0,1fr)] phone:grid-cols-[auto_3rem_minmax(0,1fr)] items-center gap-3 px-4 py-3 text-text no-underline hover:bg-surface-raised"
            >
              <Avatar name={loan.other.display_name} />
              <CardImage url={loanLines(loan)[0]?.image_url ?? null} />
              <span className="flex min-w-0 flex-col items-start gap-1">
                <span className="text-body font-semibold wrap-anywhere">
                  <Icon
                    icon={loan.role === "lender" ? ArrowUpRight : ArrowDownLeft}
                    className="mr-1 inline-block align-middle text-text-muted"
                  />
                  {loanHeadline(loan)}
                </span>
                <span className="text-meta text-text-muted wrap-anywhere">
                  {loanCardNames(loan)}
                </span>
                {status &&
                  (status.length > 30 ? (
                    <span className="text-meta text-text-muted wrap-anywhere">
                      {status}
                    </span>
                  ) : (
                    <Pill tone={loan.overdue_since ? "warn" : "neutral"}>
                      {status}
                    </Pill>
                  ))}
              </span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
