import { closeLoanRequest } from "./PendingLoanRequest";
import {
  checkEdit,
  sendCheckedEdit,
  type EditGate,
  type GateNow,
} from "./editGate";
import { useFlowGuard, useLoanRecovery } from "./LoanRecovery";
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
  onReread,
  canClose,
  pending,
  commandMessage,
  pendingRequest,
}: {
  loan: LoanView;
  deckId: string | null;
  onClose: () => void;
  onReread: () => void;
  canClose: () => boolean;
  pending: boolean;
  commandMessage: string;
  pendingRequest: ReactNode;
  onSave: (
    draft: Omit<EditTerms, "idempotency_key">
  ) => Promise<"applied" | "unknown" | "refused">;
}) {
  const loan = useRef(incomingLoan).current;
  const { store } = useLoanRecovery();
  const guard = useFlowGuard();
  const [counts, setCounts] = useState(() =>
    loan.lines.map((line) => line.requested)
  );
  const [date, setDate] = useState(loan.return_by ?? "");
  const [gate, setGate] = useState<EditGate>("checking");
  const [changedSeen, setChangedSeen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const form = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      active.current?.abort();
    };
  }, []);
  function close() {
    closeLoanRequest(form.current, !canClose(), () => {
      alive.current = false;
      active.current?.abort();
      onClose();
      if (changedSeen) onReread();
    });
  }

  function apply(next: EditGate) {
    setGate(next);
    if (next === "changed") setChangedSeen(true);
    if (next === "ok") setChangedSeen(false);
  }
  function dependencies() {
    active.current?.abort();
    const mine = new AbortController();
    active.current = mine;
    const binding = store.bind();
    if (!binding) {
      apply("error");
      return null;
    }
    const token = guard.capture();
    const path = window.location.pathname;
    return {
      read: getLoan,
      captured: { binding, opened: loan },
      signal: mine.signal,
      now: (): GateNow => {
        if (
          !alive.current ||
          !guard.live(token) ||
          window.location.pathname !== path
        )
          return { live: false };
        return {
          live: true,
          active: active.current === mine,
          aborted: mine.signal.aborted,
          binding: store.bind(),
        };
      },
      apply,
    };
  }
  useEffect(() => {
    const deps = dependencies();
    if (!deps) return;
    apply("checking");
    void checkEdit(deps);
    return () => active.current?.abort();
  }, [loan.thread_id, attempt]);
  async function save() {
    if (busy || pending || gate !== "ok") return;
    const deps = dependencies();
    if (!deps) return;
    setBusy(true);
    apply("checking");
    try {
      const result = await sendCheckedEdit({
        ...deps,
        send: () =>
          onSave({
            loan_id: loan.loan_id,
            revision: loan.revision,
            lines: loan.lines.map((line, i) => ({
              edition_id: line.edition_id,
              quantity: counts[i],
            })),
            deck_id: deckId,
            return_by: date || null,
          }),
      });
      if (!deps.now().live) return;
      if ("outcome" in result && result.outcome === "refused") {
        apply("checking");
        setAttempt((n) => n + 1);
      }
    } catch {
      const now = deps.now();
      if (now.live && now.active) apply("error");
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
        {(gate === "changed" || changedSeen) && (
          <p role="status">
            This Loan changed. Close this editor to view the current terms.
          </p>
        )}
        {gate === "error" && (
          <p role="status">
            The Loan could not be checked. Your changes are kept. Retry the
            check.
          </p>
        )}
        {commandMessage && <p role="status">{commandMessage}</p>}
        {pendingRequest}
        {gate !== "ok" && gate !== "checking" && !pending && (
          <Button onClick={() => setAttempt((n) => n + 1)}>Retry check</Button>
        )}
        <Button onClick={close}>Close</Button>
        <Button
          disabled={gate !== "ok" || busy || pending}
          onClick={() => void save()}
        >
          Save terms
        </Button>
      </div>
    </Dialog>
  );
}
