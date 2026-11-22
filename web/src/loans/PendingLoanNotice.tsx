import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/Button";
import { useFlowGuard, useLoanRecovery } from "./LoanRecovery";
import type { FlowOutcome, IntentView } from "./loanIntents";
import {
  pendingHeadline,
  RECOVERY_TEXT,
  resultText,
  signInAs,
} from "./loanText";
export function PendingLoanNotice({
  view,
  onOutcome,
  autoFocus = false,
  visible = true,
}: {
  view: IntentView;
  onOutcome: (o: FlowOutcome) => void;
  autoFocus?: boolean;
  /**
   * False while the dialog around it is closed: nothing shows, but the notice stays mounted so a check already
   * running still hands its outcome on.
   */
  visible?: boolean;
}) {
  const { store, accountName } = useLoanRecovery();
  const guard = useFlowGuard();
  const first = useRef<HTMLButtonElement>(null);
  const running = useRef(false);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (autoFocus && visible) first.current?.focus();
  }, [visible]);
  async function act(action: "replay" | "cancel" | "check") {
    if (running.current) return;
    const tok = guard.capture(),
      binding = store.bind();
    if (!binding) {
      setMessage(RECOVERY_TEXT.not_saved);
      return;
    }
    running.current = true;
    setBusy(true);
    const outcome = await store[action](binding, view.operationId);
    running.current = false;
    if (!guard.live(tok)) return;
    setBusy(false);
    setMessage(resultText(outcome));
    onOutcome(outcome);
  }
  if (!visible) return null;
  const unknown = view.state === "unknown" && !view.waitingAccount;
  return (
    <div role="status" className="flex flex-col gap-2">
      <p>{pendingHeadline(view.kind)}</p>
      {view.waitingAccount && <p>{signInAs(accountName)}</p>}
      <div className="flex flex-wrap gap-2">
        {unknown ? (
          <>
            {view.replayable && (
              <Button
                ref={first}
                aria-disabled={busy}
                onClick={() => void act("replay")}
              >
                {RECOVERY_TEXT.replay}
              </Button>
            )}
            <Button
              ref={view.replayable ? undefined : first}
              aria-disabled={busy}
              onClick={() => void act("cancel")}
            >
              {RECOVERY_TEXT.cancel}
            </Button>
          </>
        ) : (
          <Button
            ref={first}
            aria-disabled={busy}
            onClick={() => void act("check")}
          >
            {RECOVERY_TEXT.check}
          </Button>
        )}
      </div>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
