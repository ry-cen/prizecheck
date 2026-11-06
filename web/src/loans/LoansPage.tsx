import { ArrowUpRight, ArrowDownLeft, ChevronDown } from "lucide-react";
import { Avatar } from "../ui/Avatar";
import { Icon } from "../ui/Icon";
import { Pill } from "../ui/Pill";
import { useFirstReadSettled, useReadOnShow } from "../shell/keptRead";
import {
  useEffect,
  useId,
  useRef,
  useLayoutEffect,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useLoansChanged } from "../inbox/Inbox";
import { PageHeader } from "../shell/PageHeader";
import { CardImage } from "../social/FriendCollectionPage";
import { ThreadList } from "../threads/ThreadList";
import { Button } from "../ui/Button";
import { ListDetailLayout } from "../ui/ListDetailLayout";
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
  onOpenLoan: (id: string, options?: { replace?: boolean }) => void;
  onAllLoans: () => void;
  /** Opens the borrower's Deck a Loan is for (/decks/<id>). */
  onOpenDeck: (id: string) => void;
};

/**
 * The Loans tab (social network #252, spec "Web screens", Loans verdict variant E): /loans lists the collector's Loans
 * in **Needs you**, **Out now** and **Pending**, with **History** folded away; /loans/<id> is one Loan's screen
 * (LoanScreen). The tab's badge counts the Loans in Needs you, read through the inbox (#259). The list is read again
 * after a Friend command that may have cancelled Loans (#260, `useLoansChanged`).
 */
export function LoansPage({
  active,
  loanId,
  onOpenLoan,
  onAllLoans,
  onOpenDeck,
}: Props) {
  const [revision, setRevision] = useState(0);
  const opening = useRef<string | null>(null);
  useLayoutEffect(() => {
    opening.current = null;
  }, [loanId]);
  const open = (id: string) => {
    opening.current = id;
    onOpenLoan(id);
  };
  return (
    <ListDetailLayout
      selected={loanId !== null}
      queue={
        <ThreadList
          kind="loan"
          active={active}
          selected={loanId}
          revision={revision}
          onOpen={open}
        />
      }
      detail={
        loanId ? (
          <LoanScreen
            active={active}
            key={loanId}
            loanId={loanId}
            onLoanChanged={() => setRevision((n) => n + 1)}
            onCanonicalLoan={(id) => onOpenLoan(id, { replace: true })}
            focusOnOpen={opening.current === loanId}
            onAllLoans={onAllLoans}
            onOpenDeck={onOpenDeck}
          />
        ) : (
          <p className="m-0 text-body text-text-muted">Choose a Loan…</p>
        )
      }
    />
  );
}
