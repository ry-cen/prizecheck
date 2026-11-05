import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useLeaveGuard, type LeaveGuard } from "../shell/useRoute";
import { Button } from "../ui/Button";

/** Retained authority lives at the POST owner, before I/O or a recovery render.
 * Read completions cannot replace it; only a known POST outcome may settle it. */
export function useLoanCommand<T extends object>() {
  const command = useRef<T | null>(null);
  const attempting = useRef(false);
  const [pending, setPending] = useState(false);
  const boundary = useRef<HTMLElement | null>(null);
  const guard = useMemo<LeaveGuard>(
    () => ({
      blocks: () => command.current !== null,
      ask: () =>
        boundary.current
          ?.querySelector<HTMLElement>("[data-loan-explanation]")
          ?.focus(),
    }),
    []
  );
  useLeaveGuard(guard);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (command.current === null) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  const observed: Readonly<RefObject<T | null>> = command;
  return {
    command: observed,
    pending,
    boundary,
    beginAttempt(): boolean {
      if (attempting.current) return false;
      attempting.current = true;
      return true;
    },
    endAttempt() {
      attempting.current = false;
    },
    retain(value: T): T {
      if (command.current === null) {
        command.current = value;
        setPending(true);
      }
      return command.current;
    },
    settle() {
      command.current = null;
      setPending(false);
    },
  };
}

/** Every Loan command surface uses this close rule until its POST settles. */
export function closeLoanRequest(
  root: HTMLElement | null,
  retained: boolean,
  close: () => void
) {
  if (!retained) {
    close();
    return;
  }
  const dialog = root?.closest("dialog");
  if (dialog && !dialog.open) dialog.showModal();
  root?.querySelector<HTMLButtonElement>("[data-loan-retry]")?.focus();
}

/** Unknown steps have one visible route forward. Routing cannot silently discard
 * their authority; browser reload/close also carries the ordinary leave warning. */
export function PendingLoanRequest({
  busy,
  onRetry,
  boundaryRef,
}: {
  busy: boolean;
  onRetry: () => void;
  boundaryRef: RefObject<HTMLElement | null>;
}) {
  const retry = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!busy) retry.current?.focus();
  }, [busy]);
  return (
    <section
      ref={boundaryRef}
      aria-label="Pending request"
      className="flex flex-col gap-2"
    >
      <p data-loan-explanation tabIndex={-1} className="m-0 text-body">
        {busy
          ? "This request is being sent."
          : "The answer was lost. Retry sends the same request."}{" "}
        Resolve this request before leaving or making other changes.
      </p>
      <Button
        data-loan-retry
        ref={retry}
        variant="primary"
        disabled={busy}
        onClick={onRetry}
      >
        Retry request
      </Button>
    </section>
  );
}
