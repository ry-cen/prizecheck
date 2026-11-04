import {
  threadVersionChanged,
  sameLoanTermsVersion,
} from "../threads/commandChanges";
import { useEffect, useRef, useState } from "react";
import {
  editLoanTerms,
  getLoan,
  SocialError,
  type EditTerms,
  type LoanView,
} from "../social_generated";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { TextField } from "../ui/TextField";
export function LoanTermsEditor({
  loan: incomingLoan,
  deckId,
  onClose,
  onSaved,
}: {
  loan: LoanView;
  deckId: string | null;
  onClose: () => void;
  onSaved: () => void;
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
  const pending = useRef<EditTerms | null>(null);
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
      if (!pending.current) {
        const fresh = await getLoan(loan.thread_id);
        if (!matches(fresh)) {
          setReady(false);
          setMessage(
            "This Loan changed. Close this editor to view the current terms."
          );
          return;
        }
        pending.current = {
          loan_id: loan.loan_id,
          revision: loan.revision,
          idempotency_key: crypto.randomUUID(),
          lines: loan.lines.map((line, i) => ({
            edition_id: line.edition_id,
            quantity: counts[i],
          })),
          deck_id: deckId,
          return_by: date || null,
        };
      }
      await editLoanTerms(loan.thread_id, pending.current);
      onSaved();
    } catch (cause) {
      if (cause instanceof SocialError && threadVersionChanged(cause.code)) {
        pending.current = null;
        setReady(false);
        setAttempt((n) => n + 1);
        setMessage(
          "The Loan terms changed. Your changes are kept. Review the current Loan before trying again."
        );
        return;
      }
      if (cause instanceof SocialError && cause.status < 500)
        pending.current = null;
      setMessage(
        "The change could not be confirmed. Your changes are kept; retry uses the same command."
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open title="Change Loan terms" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <h2>Change Loan terms</h2>
        {loan.lines.map((line, i) => (
          <TextField
            key={line.edition_id}
            label={line.name}
            type="number"
            min="1"
            max="9999"
            value={counts[i]}
            disabled={busy || pending.current !== null}
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
          disabled={busy || pending.current !== null}
          onChange={(event) => setDate(event.target.value)}
        />
        <p role="status">{message}</p>
        {!ready && (
          <Button onClick={() => setAttempt((n) => n + 1)}>Retry check</Button>
        )}
        <Button onClick={onClose}>Close</Button>
        <Button disabled={!ready || busy} onClick={() => void save()}>
          Save terms
        </Button>
      </div>
    </Dialog>
  );
}
