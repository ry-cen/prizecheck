import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useNoteLoansChanged, usePollPulse } from "../inbox/Inbox";
import { CANCEL } from "../social/blockMessages";
import { endingText, traderEnding } from "../social/friendshipEnding";
import {
  getLoans,
  getTrades,
  reportCollector,
  type ReportCollector,
} from "../social_generated";
import { Button } from "../ui/Button";
import type { MenuItem } from "../ui/Menu";
import { TextArea } from "../ui/TextField";
import {
  NOTE_LABEL,
  REASON_LEGEND,
  REASONS,
  REPORT,
  REPORT_HELP,
  reportedStatus,
  reportMessage,
  reportQuestion,
} from "./reportMessages";

/**
 * Who a Report is for: the collector's trader id and name, their Handle when they are a Friend, and the Trade when it
 * is reported from one.
 */
export type ReportTarget = {
  traderId: string;
  name: string;
  handle: string | null;
  tradeId?: string;
};

type Reason = ReportCollector["reason"];
type Form = {
  target: ReportTarget;
  key: string;
  reason: Reason | null;
  note: string;
  error: string;
};
type State =
  | { kind: "idle" }
  | ({ kind: "asking" } & Form)
  | ({ kind: "busy" } & Form)
  | { kind: "done"; text: string };

/**
 * Report by trader id (Trading #303), for a conversation, a Near you row and a Trade. `item` is the menu item;
 * choosing it opens a form with the reasons and an optional note and what the Block would end, and Report then reports.
 * A Report also Blocks the collector, and they are never told. A caller whose control vanishes on success (a row)
 * shows the status through `onReported` and sets `statusElsewhere`.
 */
export function useTraderReport(
  target: ReportTarget | null,
  options: {
    source: ReportCollector["source"];
    onReported?: (status: string) => void;
    /** The caller shows `onReported`'s status itself, so `panel` shows none. */
    statusElsewhere?: boolean;
    returnFocus?: () => void;
  }
): { item: MenuItem | null; panel: ReactNode } {
  const [state, setState] = useState<State>({ kind: "idle" });
  const noteLoansChanged = useNoteLoansChanged();
  const pollPulse = usePollPulse();
  const groupName = useId();
  const helpId = useId();
  const first = useRef<HTMLInputElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const failed = useRef(false);
  const reading = useRef<AbortController | null>(null);
  const [ending, setEnding] = useState("");
  useEffect(() => () => reading.current?.abort(), []);
  // A failed Report leaves the form asking again; focus returns to Report once its button is enabled.
  useEffect(() => {
    if (state.kind === "asking" && failed.current) {
      failed.current = false;
      submitButton.current?.focus();
    }
  }, [state]);
  const asking = state.kind === "asking" || state.kind === "busy";
  useEffect(() => {
    if (state.kind === "asking") first.current?.focus();
    // Focus moves once, when the form opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asking]);

  function ask(who: ReportTarget) {
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    setEnding("");
    Promise.all([
      getTrades(controller.signal),
      who.handle ? getLoans(controller.signal) : Promise.resolve(null),
    ])
      .then(([trades, loans]) => {
        if (controller.signal.aborted) return;
        setEnding(
          endingText(
            traderEnding(
              loans ? loans.loans : null,
              trades.trades,
              who.traderId,
              who.handle
            )
          )
        );
      })
      .catch(() => undefined);
    setState({
      kind: "asking",
      target: who,
      key: crypto.randomUUID(),
      reason: null,
      note: "",
      error: "",
    });
  }

  /** A changed input is a new Report, so it never reuses the earlier key. */
  function change(form: Form, changes: Partial<Pick<Form, "reason" | "note">>) {
    setState({
      ...form,
      kind: "asking",
      ...changes,
      key: crypto.randomUUID(),
      error: "",
    });
  }

  async function submit(form: Form) {
    if (form.reason === null) return;
    setState({ ...form, kind: "busy" });
    try {
      await reportCollector({
        trader_id: form.target.traderId,
        reason: form.reason,
        note: form.note.trim() ? form.note : null,
        source: options.source,
        trade_id:
          options.source === "trade" ? (form.target.tradeId ?? null) : null,
        idempotency_key: form.key,
      });
      const text = reportedStatus(form.target.name);
      // A caller that shows the status itself (a row that vanishes) gets no second announcement here.
      setState(
        options.statusElsewhere ? { kind: "idle" } : { kind: "done", text }
      );
      noteLoansChanged();
      pollPulse();
      options.onReported?.(text);
    } catch (cause) {
      failed.current = true;
      setState({ ...form, kind: "asking", error: reportMessage(cause) });
    }
  }

  function cancel() {
    reading.current?.abort();
    setState({ kind: "idle" });
    options.returnFocus?.();
  }

  const item: MenuItem | null = target
    ? { label: REPORT, onSelect: () => ask(target) }
    : null;

  // Like Block's, the live region is always drawn, empty and hidden until there is something to say, so the text is
  // announced when it arrives. A page with both hooks has two, so a test names the one it means by its text.
  const panel = (
    <>
      {(state.kind === "asking" || state.kind === "busy") && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(state);
          }}
        >
          <fieldset
            aria-describedby={helpId}
            className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0"
          >
            <legend className="p-0 text-body font-medium text-text">
              {reportQuestion(state.target.name)}
            </legend>
            <p id={helpId} className="m-0 text-meta text-text-muted">
              {REPORT_HELP}
              {ending ? ` ${ending}` : ""}
            </p>
            <fieldset className="m-0 flex min-w-0 flex-col border-0 p-0">
              <legend className="p-0 text-meta text-text-muted">
                {REASON_LEGEND}
              </legend>
              {REASONS.map((reason, index) => (
                <label
                  key={reason.value}
                  className="flex min-h-control cursor-pointer items-center gap-2 text-body text-text phone:min-h-tap"
                >
                  <input
                    ref={index === 0 ? first : undefined}
                    type="radio"
                    name={groupName}
                    value={reason.value}
                    checked={state.reason === reason.value}
                    disabled={state.kind === "busy"}
                    onChange={() => change(state, { reason: reason.value })}
                    className="m-0 size-4 shrink-0 accent-accent"
                  />
                  {reason.label}
                </label>
              ))}
            </fieldset>
            <TextArea
              label={NOTE_LABEL}
              maxLength={1000}
              value={state.note}
              disabled={state.kind === "busy"}
              onChange={(event) => change(state, { note: event.target.value })}
            />
          </fieldset>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              ref={submitButton}
              type="submit"
              aria-describedby={helpId}
              variant="danger"
              disabled={state.kind === "busy" || state.reason === null}
            >
              {REPORT}
            </Button>
            <Button onClick={cancel}>{CANCEL}</Button>
          </div>
          {state.error && (
            <p role="alert" className="m-0 text-meta text-danger">
              {state.error}
            </p>
          )}
        </form>
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
    </>
  );
  return { item, panel };
}
