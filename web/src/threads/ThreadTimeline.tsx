import { TradingAvailability } from "./TradingAvailability";
import { ThreadMenu } from "./ThreadMenu";
import { MESSAGE_LENGTH_TEXT, threadMessageError } from "./threadMessage";
import { mergeTimeline } from "./timelineHistory";
import { timelineText } from "./threadText";
import { useEffect, useRef, useState } from "react";
import {
  getThreadDetail,
  getBlocked,
  type TradeDetail,
  getThreadTimeline,
  sendThreadMessage,
  readThread,
  SocialError,
  type Timeline,
} from "../social_generated";
import {
  useConversationOpen,
  usePulseChanged,
  usePollPulse,
} from "../inbox/Inbox";
import { Button } from "../ui/Button";
import { TextArea } from "../ui/TextField";
export function ThreadTimeline({
  kind,
  id,
  active = true,
  editionNames = {},
  onChanged,
}: {
  kind: "trade" | "loan";
  id: string;
  active?: boolean;
  editionNames?: Record<string, string>;
  onChanged?: () => void;
}) {
  const [log, setLog] = useState<Timeline | null>(null),
    [failed, setFailed] = useState(false),
    [attempt, setAttempt] = useState(0);
  const [body, setBody] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [permissionFailed, setPermissionFailed] = useState(false);
  const [tradeDetail, setTradeDetail] = useState<TradeDetail | null>(null);
  const [ownBlock, setOwnBlock] = useState(false);
  const [name, setName] = useState("Other collector");
  const [canMessage, setCanMessage] = useState<boolean | null>(null);
  const pending = useRef<{ body: string; idempotency_key: string } | null>(
    null
  );
  const title = useRef<HTMLHeadingElement>(null);
  const epoch = useRef(0);
  const changed = usePulseChanged(),
    poll = usePollPulse();
  useConversationOpen(active);
  useEffect(() => {
    if (!active) return;
    setCanMessage(null);
    setPermissionFailed(false);
    ++epoch.current;
    const controller = new AbortController();
    void getThreadDetail(kind, id, controller.signal).then(
      (detail) => {
        if (!controller.signal.aborted) {
          setCanMessage(detail.can_message);
          if ("live_offer" in detail) {
            setTradeDetail(detail);
            const trader = detail.live_offer.other.trader_id;
            if (!detail.can_message && trader)
              void getBlocked().then(
                (answer) => {
                  if (!controller.signal.aborted)
                    setOwnBlock(
                      answer.blocked.some((row) => row.trader_id === trader)
                    );
                },
                () => {}
              );
            else setOwnBlock(false);
          }
          setName(
            ("live_offer" in detail ? detail.live_offer : detail.live_terms)
              .other.display_name
          );
        }
      },
      () => {
        if (!controller.signal.aborted) {
          setCanMessage(null);
          setPermissionFailed(true);
        }
      }
    );
    getThreadTimeline(kind, id, null, controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return;
        setLog((current) => mergeTimeline(current, next, true));
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
    return () => {
      ++epoch.current;
      controller.abort();
    };
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
    const started = epoch.current;
    try {
      const page = await getThreadTimeline(kind, id, log.next_before);
      if (started !== epoch.current) return;
      setLog((current) => mergeTimeline(current, page, false));
    } catch {
      if (started !== epoch.current) return;
      setMessage("Earlier messages could not be loaded. Please retry.");
    }
  }
  async function send() {
    if (busy) return;
    if (!pending.current && Array.from(body).length > 4000) {
      setMessage(MESSAGE_LENGTH_TEXT);
      return;
    }
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
        setMessage(threadMessageError(cause));
      } else setMessage("The answer was lost. Retry sends the same message.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="Chat and changes"
      className="flex min-w-0 flex-col gap-3 border-t border-border pt-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 ref={title} tabIndex={-1} className="text-heading">
          Chat and changes
        </h2>
        {tradeDetail?.live_offer.other.trader_id && (
          <ThreadMenu
            target={{
              traderId: tradeDetail.live_offer.other.trader_id,
              name,
              handle: tradeDetail.live_offer.other.friend
                ? tradeDetail.live_offer.other.handle
                : null,
            }}
            canMessage={canMessage === true}
            canReport={tradeDetail.can_report}
            offerId={tradeDetail.live_offer.offer_id}
            onChanged={() => {
              title.current?.focus();
              setAttempt((n) => n + 1);
              onChanged?.();
            }}
          />
        )}
      </div>
      <TradingAvailability
        enabled={canMessage === false}
        revision={`${attempt}:${changed}`}
      />
      {ownBlock && <a href="/settings">You blocked {name}.</a>}
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
      <ol
        aria-label="Messages and changes"
        className="m-0 flex list-none flex-col gap-3 p-0"
      >
        {[...(log?.items ?? [])].reverse().map((item) => (
          <li key={item.cursor} className="whitespace-pre-wrap wrap-anywhere">
            {timelineText(item, log!.you_are, name, editionNames)}
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
            label={`Message ${name}`}
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
      ) : canMessage === null ? (
        <p role="status">
          {permissionFailed ? "Chat couldn't be checked." : "Checking chat…"}{" "}
          <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
        </p>
      ) : (
        <p>This collector is no longer available</p>
      )}
      {message && <p role="alert">{message}</p>}
    </section>
  );
}
