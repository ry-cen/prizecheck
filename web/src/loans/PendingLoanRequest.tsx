import { useEffect, useMemo, useRef } from "react";
import { useLeaveGuard, type LeaveGuard } from "../shell/useRoute";
import { Button } from "../ui/Button";

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
}: {
  busy: boolean;
  onRetry: () => void;
}) {
  const explanation = useRef<HTMLParagraphElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!busy) retry.current?.focus();
  }, [busy]);
  const guard = useMemo<LeaveGuard>(
    () => ({
      blocks: () => true,
      ask: () => explanation.current?.focus(),
    }),
    []
  );
  useLeaveGuard(guard);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  return (
    <section aria-label="Pending request" className="flex flex-col gap-2">
      <p ref={explanation} tabIndex={-1} className="m-0 text-body">
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
