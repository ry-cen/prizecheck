import { useCallback, useEffect, useRef, useState } from "react";
import { useLoansChanged, usePulseChanged } from "../inbox/Inbox";
import { getWaitingLoans, type WaitingLine } from "../social_generated";

/** The open Loan lines to one Friend for one Card Edition, any Deck or none, in the server's order. */
export function earlierFor(
  lines: WaitingLine[],
  lenderId: string,
  editionId: string
): WaitingLine[] {
  return lines.filter(
    (line) => line.lender_id === lenderId && line.edition_id === editionId
  );
}

/** "Asked Misty for 2 · Sky Deck", or "Misty agreed to lend 1 · Unsorted"; no place when it isn't known. */
export function earlierText(line: WaitingLine, place: string | null): string {
  const text =
    line.state === "accepted"
      ? `${line.lender} agreed to lend ${line.copies}`
      : `Asked ${line.lender} for ${line.copies}`;
  return place ? `${text} · ${place}` : text;
}

/**
 * What the collector is still waiting on from Friends, for the Borrow Request composer's earlier-request notes
 * (`GET /api/loans/waiting`). Reads on mount, when the inbox pulse or the Loans change, on `retry` and on return to the
 * tab. A failed read keeps the last answer; with none it says `failed`. It never gates sending.
 */
export function useEarlierRequests(): {
  state: "loading" | "ready" | "failed";
  lines: WaitingLine[];
  retry: () => void;
} {
  const pulse = usePulseChanged(),
    loans = useLoansChanged();
  const [attempt, setAttempt] = useState(0);
  const [lines, setLines] = useState<WaitingLine[] | null>(null);
  const [failed, setFailed] = useState(false);
  const away = useRef(false);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    const leave = () => {
      away.current = true;
    };
    const returned = () => {
      if (away.current && document.visibilityState !== "hidden") {
        away.current = false;
        retry();
      }
    };
    const visibility = () =>
      document.visibilityState === "hidden" ? leave() : returned();
    window.addEventListener("blur", leave);
    window.addEventListener("focus", returned);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("blur", leave);
      window.removeEventListener("focus", returned);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [retry]);
  useEffect(() => {
    if (document.visibilityState === "hidden") {
      away.current = true;
      return;
    }
    const controller = new AbortController();
    getWaitingLoans(controller.signal).then(
      (answer) => {
        if (controller.signal.aborted) return;
        setLines(answer.lines);
        setFailed(false);
      },
      () => {
        if (!controller.signal.aborted) setFailed(true);
      }
    );
    return () => controller.abort();
  }, [pulse, loans, attempt]);
  const none = useRef<WaitingLine[]>([]);
  return {
    state: lines ? "ready" : failed ? "failed" : "loading",
    lines: lines ?? none.current,
    retry,
  };
}
