import { useEffect, useRef, useState } from "react";
import {
  getThreadDetail,
  getThreadTimeline,
  sendThreadMessage,
  readThread,
  SocialError,
  type Timeline,
  type TimelineItem,
} from "../social_generated";
import {
  useConversationOpen,
  usePulseChanged,
  usePollPulse,
} from "../inbox/Inbox";
import { Button } from "../ui/Button";
import { TextArea } from "../ui/TextField";
const EVENTS: Record<string, string> = {
  proposed: "Proposed a Trade",
  agreed: "Agreed",
  changed_after_agreement: "Changed the agreed offer",
  countered: "Changed the offer",
  changed: "Changed terms",
  returned_all: "Recorded all copies back",
  accepted: "Agreed",
  declined: "Declined",
  withdrawn: "Withdrawn",
  cancelled: "Cancelled",
  offer_changed: "Changed the offer",
  confirmed_swap: "Confirmed swap",
  swapped: "Confirmed swap",
  requested: "Asked to borrow",
  offered: "Offered to lend",
  terms_changed: "Changed Loan terms",
  handover: "Confirmed handover",
  returned: "Confirmed return",
  return_started: "Started a return",
  written_off: "Wrote off copies",
  take_back: "Took back handover",
};
export function ThreadTimeline({
  kind,
  id,
  active = true,
  editionNames = {},
}: {
  kind: "trade" | "loan";
  id: string;
  active?: boolean;
  editionNames?: Record<string, string>;
}) {
  const [log, setLog] = useState<Timeline | null>(null),
    [failed, setFailed] = useState(false),
    [attempt, setAttempt] = useState(0);
  const [body, setBody] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [canMessage, setCanMessage] = useState(false);
  const pending = useRef<{ body: string; idempotency_key: string } | null>(
    null
  );
  const changed = usePulseChanged(),
    poll = usePollPulse();
  useConversationOpen();
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void getThreadDetail(kind, id, controller.signal).then(
      (detail) => {
        if (!controller.signal.aborted) setCanMessage(detail.can_message);
      },
      () => {
        if (!controller.signal.aborted) setCanMessage(false);
      }
    );
    getThreadTimeline(kind, id, null, controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return;
        setLog(next);
        setFailed(false);
        if (next.items[0] && document.visibilityState === "visible")
          void readThread(kind, id, { through: next.items[0].cursor }).then(
            poll,
            () => {}
          );
      },
      () => {
        if (!controller.signal.aborted) setFailed(true);
      }
    );
    return () => controller.abort();
  }, [kind, id, changed, attempt, active]);
  useEffect(() => {
    const show = () => {
      if (active && document.visibilityState === "visible")
        setAttempt((n) => n + 1);
    };
    document.addEventListener("visibilitychange", show);
    return () => document.removeEventListener("visibilitychange", show);
  }, [active]);
  async function earlier() {
    if (!log?.next_before) return;
    try {
      const page = await getThreadTimeline(kind, id, log.next_before);
      setLog((current) =>
        current
          ? {
              ...current,
              items: [
                ...current.items,
                ...page.items.filter(
                  (item) =>
                    !current.items.some((old) => old.cursor === item.cursor)
                ),
              ],
              next_before: page.next_before,
            }
          : page
      );
    } catch {
      setMessage("Earlier messages could not be loaded. Please retry.");
    }
  }
  async function send() {
    if (busy) return;
    const command = pending.current ?? {
      body,
      idempotency_key: crypto.randomUUID(),
    };
    pending.current = command;
    setBusy(true);
    setMessage("");
    try {
      await sendThreadMessage(kind, id, command);
      pending.current = null;
      setBody("");
      setAttempt((n) => n + 1);
      poll();
    } catch (cause) {
      if (cause instanceof SocialError && cause.status < 500) {
        pending.current = null;
        setMessage(
          cause.code === "COLLECTOR_UNAVAILABLE"
            ? "This collector is no longer available."
            : "Your message could not be sent."
        );
      } else setMessage("The answer was lost. Retry sends the same message.");
    } finally {
      setBusy(false);
    }
  }
  function text(item: TimelineItem) {
    if (item.message)
      return `${item.message.from === "you" ? "You" : "Them"}: ${item.message.body}`;
    const event = item.event;
    if (!event) return "";
    return `${event.actor ? (event.actor === log?.you_are ? "You: " : "Them: ") : ""}${EVENTS[event.kind] ?? "Agreement updated"}${(event.data?.lines ?? []).map((line) => ` · ${line.giver === log?.you_are ? "You give" : "They give"} ${editionNames[line.edition_id] ?? "copies"}: ${line.from_qty} → ${line.to_qty}`).join("")}${event.data?.return_by ? ` · Return by: ${event.data.return_by.from ?? "None"} → ${event.data.return_by.to ?? "None"}` : ""}`;
  }
  return (
    <section
      aria-label="Chat and changes"
      className="flex min-w-0 flex-col gap-3 border-t border-border pt-4"
    >
      <h2 className="text-heading">Chat and changes</h2>
      {failed && (
        <p role="status">
          The timeline couldn't be loaded.{" "}
          <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
        </p>
      )}
      {!log && !failed && <p role="status">Loading messages…</p>}
      {log?.next_before && (
        <Button onClick={() => void earlier()}>Show earlier</Button>
      )}
      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        {[...(log?.items ?? [])].reverse().map((item) => (
          <li key={item.cursor} className="whitespace-pre-wrap wrap-anywhere">
            {text(item)}
          </li>
        ))}
      </ol>
      {canMessage ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
          className="flex flex-col gap-2"
        >
          <TextArea
            label="Message"
            value={body}
            disabled={busy || pending.current !== null}
            onChange={(event) => setBody(event.target.value)}
            maxLength={4000}
          />
          <Button
            type="submit"
            disabled={busy || (!body.trim() && !pending.current)}
          >
            {busy ? "Sending…" : pending.current ? "Retry" : "Send"}
          </Button>
        </form>
      ) : (
        <p>This chat is read-only.</p>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
