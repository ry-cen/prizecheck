import { useEffect, useState, type MouseEvent, type RefObject } from "react";
import { CardImage } from "../social/FriendCollectionPage";
import { getLentOut, type LentOut } from "../social_generated";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { loanPath } from "./loanText";

type Load =
  { kind: "loading" } | { kind: "failed" } | { kind: "ready"; view: LentOut };

/**
 * The Collection's **Lent out** list (social network #253, spec "Collection"): every copy the collector handed over
 * and hasn't had back, each row "2 lent to Ash K." with its card, and a link to its Loan. Read each time it opens.
 */
export function LentOutDialog({
  open,
  onClose,
  onOpenLoan,
  returnFocus,
}: {
  open: boolean;
  onClose: () => void;
  onOpenLoan: (id: string) => void;
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoad({ kind: "loading" });
    getLentOut(controller.signal).then(
      (view) => {
        if (!controller.signal.aborted) setLoad({ kind: "ready", view });
      },
      () => {
        if (!controller.signal.aborted) setLoad({ kind: "failed" });
      }
    );
    return () => controller.abort();
  }, [open, attempt]);

  let body;
  if (load.kind === "loading")
    body = (
      <p role="status" className="m-0 text-body text-text-muted">
        Loading lent cards…
      </p>
    );
  else if (load.kind === "failed")
    body = (
      <div className="flex flex-wrap items-center gap-3">
        <p role="status" className="m-0 text-body text-text-muted">
          Your lent cards couldn't be loaded.
        </p>
        <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
      </div>
    );
  else if (load.view.cards.length === 0)
    body = (
      <p className="m-0 text-body text-text-muted">Nothing is lent out now.</p>
    );
  else
    body = (
      <ul
        aria-label="Lent cards"
        className="m-0 list-none overflow-hidden rounded-panel border border-border bg-surface p-0"
      >
        {load.view.cards.map((card) => (
          <li
            key={`${card.loan_id}:${card.edition_id}`}
            className="border-b border-border last:border-b-0"
          >
            <a
              href={loanPath(card.loan_id)}
              onClick={(event: MouseEvent) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                event.preventDefault();
                onClose();
                onOpenLoan(card.loan_id);
              }}
              className="grid min-h-tap grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-3 px-4 py-3 text-text no-underline hover:bg-surface-raised"
            >
              <CardImage url={card.image_url} />
              <span className="flex min-w-0 flex-col">
                <span className="text-body font-semibold wrap-anywhere">
                  {card.name}
                </span>
                <span className="text-meta text-text-muted wrap-anywhere">
                  {card.set_code} {card.collector_number}
                </span>
                <span className="text-meta text-text-subtle wrap-anywhere">
                  {card.copies} lent to {card.borrower}
                </span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Lent out"
      closeLabel="Close Lent out"
      returnFocus={returnFocus}
    >
      {body}
    </Dialog>
  );
}
