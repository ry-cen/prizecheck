import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useNoteLoansChanged, usePollPulse } from "../inbox/Inbox";
import {
  BLOCK,
  blockedStatus,
  blockQuestion,
  CANCEL,
} from "../social/blockMessages";
import { endingText, traderEnding } from "../social/friendshipEnding";
import { commandMessage } from "../social/socialMessages";
import { blockTrader, getLoans, getTrades } from "../social_generated";
import { Button } from "../ui/Button";
import type { MenuItem } from "../ui/Menu";

/** Who a Block is for: the collector's trader id and name, and their Handle when they are a Friend. */
export type BlockTarget = {
  traderId: string;
  name: string;
  handle: string | null;
};

type State =
  | { kind: "idle" }
  | { kind: "asking"; target: BlockTarget; key: string; cancels: string }
  | { kind: "busy"; target: BlockTarget; key: string; cancels: string }
  | { kind: "done"; text: string }
  | { kind: "failed"; text: string };

/**
 * Block by trader id (Trading #302), for any screen that shows another collector by trader id (a conversation, a Near
 * you row). `item` is the menu item; choosing it asks the Block question with
 * what the Block cancels, and Block then blocks. The page shows `panel` under the control. A caller whose control
 * vanishes on success (a row) shows the status through `onBlocked` and sets `statusElsewhere`.
 */
export function useTraderBlock(
  target: BlockTarget | null,
  options: {
    onBlocked?: (status: string) => void;
    /** The caller shows `onBlocked`'s status itself, so `panel` shows none. */
    statusElsewhere?: boolean;
    returnFocus?: () => void;
  } = {}
): { item: MenuItem | null; panel: ReactNode } {
  const [state, setState] = useState<State>({ kind: "idle" });
  const noteLoansChanged = useNoteLoansChanged();
  const pollPulse = usePollPulse();
  const questionId = useId();
  const primary = useRef<HTMLButtonElement>(null);
  const reading = useRef<AbortController | null>(null);
  useEffect(() => () => reading.current?.abort(), []);
  const asking = state.kind === "asking" || state.kind === "busy";
  useEffect(() => {
    if (state.kind === "asking") primary.current?.focus();
    // Focus moves once, when the question appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asking]);

  function ask(who: BlockTarget) {
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    const key = crypto.randomUUID();
    setState({ kind: "asking", target: who, key, cancels: "" });
    Promise.all([
      getTrades(controller.signal),
      who.handle ? getLoans(controller.signal) : Promise.resolve(null),
    ])
      .then(([trades, loans]) => {
        if (controller.signal.aborted) return;
        const cancels = endingText(
          traderEnding(
            loans ? loans.loans : null,
            trades.trades,
            who.traderId,
            who.handle
          )
        );
        setState((current) =>
          current.kind === "asking" && current.key === key
            ? { ...current, cancels }
            : current
        );
      })
      .catch(() => undefined);
  }

  async function confirm(current: Extract<State, { kind: "asking" | "busy" }>) {
    setState({ ...current, kind: "busy" });
    try {
      await blockTrader(current.target.traderId, {
        idempotency_key: current.key,
      });
      const text = blockedStatus(current.target.name);
      // A caller that shows the status itself (a row that vanishes) gets no second announcement here.
      setState(
        options.statusElsewhere ? { kind: "idle" } : { kind: "done", text }
      );
      noteLoansChanged();
      pollPulse();
      options.onBlocked?.(text);
    } catch (cause) {
      setState({ kind: "failed", text: commandMessage(cause) });
      options.returnFocus?.();
    }
  }

  function cancel() {
    reading.current?.abort();
    setState({ kind: "idle" });
    options.returnFocus?.();
  }

  const item: MenuItem | null = target
    ? { label: BLOCK, onSelect: () => ask(target) }
    : null;

  const question =
    state.kind === "asking" || state.kind === "busy"
      ? blockQuestion(state.target.name) +
        (state.cancels ? ` ${state.cancels}` : "")
      : "";
  const panel = (
    <>
      {(state.kind === "asking" || state.kind === "busy") && (
        <div className="flex flex-wrap items-center gap-2">
          <span id={questionId} className="min-w-0 text-body">
            {question}
          </span>
          <Button
            ref={primary}
            aria-describedby={questionId}
            variant="danger"
            disabled={state.kind === "busy"}
            onClick={() => void confirm(state)}
          >
            {BLOCK}
          </Button>
          <Button onClick={cancel}>{CANCEL}</Button>
        </div>
      )}
      {!options.statusElsewhere && (
        <p
          role="status"
          className={
            state.kind === "done" ? "m-0 text-meta text-text-muted" : "sr-only"
          }
        >
          {state.kind === "done" ? state.text : ""}
        </p>
      )}
      {state.kind === "failed" && (
        <p role="alert" className="m-0 text-meta text-danger">
          {state.text}
        </p>
      )}
    </>
  );
  return { item, panel };
}
