import { closeLoanRequest } from "./PendingLoanRequest";
import { sameLoanTermsVersion } from "../threads/commandChanges";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { getLoan, type EditTerms, type LoanView } from "../social_generated";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { TextField } from "../ui/TextField";
export function LoanTermsEditor({
  loan: incomingLoan,
  deckId,
  onClose,
  onSave,
  canClose,
  pending,
  commandMessage,
  pendingRequest,
}: {
  loan: LoanView;
  deckId: string | null;
  onClose: () => void;
  canClose: () => boolean;
  pending: boolean;
  commandMessage: string;
  pendingRequest: ReactNode;
  onSave: (
    draft: Omit<EditTerms, "idempotency_key">
  ) => Promise<"applied" | "unknown" | "refused">;
}) {
  const loan = useRef(incomingLoan).current;
  const [counts, setCounts] = useState(() =>
    loan.lines.map((line) => line.requested)
  );
  const [date, setDate] = useState(loan.return_by ?? "");
  const [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [attempt, setAttempt] = useState(0);
  const form = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  function close() {
    closeLoanRequest(form.current, !canClose(), onClose);
  }

  function matches(fresh: LoanView) {
    return sameLoanTermsVersion(loan, fresh);
  }
  useEffect(() => {
    const controller = new AbortController();
    setReady(false);
    getLoan(loan.thread_id, controller.signal).then(
      (fresh) => {
        if (controller.signal.aborted) return;
        setReady(matches(fresh));
        setMessage(
          matches(fresh)
            ? ""
            : "This Loan changed. Close this editor to view the current terms."
        );
      },
      () => {
        if (!controller.signal.aborted)
          setMessage(
            "The Loan could not be checked. Your changes are kept. Retry the check."
          );
      }
    );
    return () => controller.abort();
  }, [loan.thread_id, attempt]);
  async function save() {
    if (busy || !ready) return;
    setBusy(true);
    try {
      const fresh = await getLoan(loan.thread_id);
      if (!alive.current) return;
      if (!matches(fresh)) {
        setReady(false);
        setMessage(
          "This Loan changed. Close this editor to view the current terms."
        );
        return;
      }
      const result = await onSave({
        loan_id: loan.loan_id,
        revision: loan.revision,
        lines: loan.lines.map((line, i) => ({
          edition_id: line.edition_id,
          quantity: counts[i],
        })),
        deck_id: deckId,
        return_by: date || null,
      });
      if (!alive.current) return;
      if (result === "refused") {
        setReady(false);
        setAttempt((n) => n + 1);
      }
    } catch {
      if (alive.current)
        setMessage(
          "The Loan could not be checked. Your changes are kept. Retry the check."
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <Dialog open title="Change Loan terms" onClose={close}>
      <div ref={form} className="flex flex-col gap-3">
        <h2>Change Loan terms</h2>
        {loan.lines.map((line, i) => (
          <TextField
            key={line.edition_id}
            label={line.name}
            type="number"
            min="1"
            max="9999"
            value={counts[i]}
            disabled={busy || pending}
            onChange={(event) =>
              setCounts((old) =>
                old.map((n, j) => (i === j ? event.target.value : n))
              )
            }
          />
        ))}
        <TextField
          label="Return by (optional)"
          type="date"
          value={date}
          disabled={busy || pending}
          onChange={(event) => setDate(event.target.value)}
        />
        <p role="status">{commandMessage || message}</p>
        {pendingRequest}
        {!ready && !pending && (
          <Button onClick={() => setAttempt((n) => n + 1)}>Retry check</Button>
        )}
        <Button onClick={close}>Close</Button>
        <Button
          disabled={!ready || busy || pending}
          onClick={() => void save()}
        >
          Save terms
        </Button>
      </div>
    </Dialog>
  );
}
