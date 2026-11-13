import { TradingAvailability } from "./TradingAvailability";
import type { BlockTarget } from "../trades/TraderBlock";
import { ThreadMenu } from "./ThreadMenu";
import { MESSAGE_LENGTH_TEXT, threadMessageError } from "./threadMessage";
import { mergeTimeline } from "./timelineHistory";
import { timelineText } from "./threadText";
import { useEffect, useId, useRef, useState } from "react";
import {
  getThreadDetail,
  getTrader,
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
function ThreadTimelineContent({
  kind,
  id,
  active = true,
  editionNames = {},
  onChanged,
  revision,
}: {
  kind: "trade" | "loan";
  id: string;
  active?: boolean;
  editionNames?: Record<string, string>;
  onChanged?: () => void;
  revision?: string;
}) {
  const hintId = useId();
  const [finePointer, setFinePointer] = useState(false);
  useEffect(() => {
    if (!window.matchMedia) return;
    const media = window.matchMedia("(pointer: fine)");
    const update = () => setFinePointer(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const shortcut = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
    ? "⌘+Enter to send"
    : "Ctrl+Enter to send";
  const [log, setLog] = useState<Timeline | null>(null),
    [failed, setFailed] = useState(false),
    [attempt, setAttempt] = useState(0);
  const [body, setBody] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [permissionFailed, setPermissionFailed] = useState(false);
  const [checkingPermission, setCheckingPermission] = useState(true);
  const [moderation, setModeration] = useState<{
    target: BlockTarget;
    canReport: boolean;
    offerId?: string;
  } | null>(null);
  const [ownBlock, setOwnBlock] = useState(false);
  const [name, setName] = useState("Other collector");
  const [canMessage, setCanMessage] = useState<boolean | null>(null);
  const currentPermission = useRef(canMessage);
  currentPermission.current = canMessage;
  const pending = useRef<{ body: string; idempotency_key: string } | null>(
    null
  );
  // A press during a permission recheck is intent only: no command/key yet.
  const held = useRef<{ body: string } | null>(null);
  const [holding, setHolding] = useState(false);
  const permissionRead = useRef<"reading" | "ready" | "failed">("reading");
  const posting = useRef(false);
  const alive = useRef(true);
  const title = useRef<HTMLHeadingElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const epoch = useRef(0);
  const changed = usePulseChanged(),
    poll = usePollPulse();
  useConversationOpen(active);
  useEffect(() => {
    if (!active) return;
    permissionRead.current = "reading";
    setCheckingPermission(true);
    setPermissionFailed(false);
    ++epoch.current;
    const controller = new AbortController();
    void getThreadDetail(kind, id, controller.signal).then(
      (detail) => {
        if (!controller.signal.aborted) {
          permissionRead.current = "ready";
          // A background read keeps the editor node and its keyboard position.
          // If chat really closes, move focus deliberately before removing it.
          if (
            !detail.can_message &&
            !pending.current &&
            (held.current !== null || document.activeElement === editor.current)
          )
            title.current?.focus();
          setCanMessage(detail.can_message);
          setCheckingPermission(false);
          const other =
            "live_offer" in detail ? detail.live_offer.other : detail.other;
          setName(other.display_name);
          setModeration(
            other.trader_id
              ? {
                  target: {
                    traderId: other.trader_id,
                    name: other.display_name,
                    handle:
                      "live_offer" in detail && detail.live_offer.other.friend
                        ? detail.live_offer.other.handle
                        : null,
                    collectorId:
                      "live_terms" in detail && detail.other.friend
                        ? detail.live_terms.other.collector_id
                        : null,
                  },
                  canReport: detail.can_report,
                  offerId:
                    "live_offer" in detail
                      ? detail.live_offer.offer_id
                      : undefined,
                }
              : null
          );
          if (!detail.can_message && other.trader_id)
            void getTrader(other.trader_id, controller.signal).then(
              (answer) => {
                if (!controller.signal.aborted)
                  setOwnBlock(answer.status === "you_blocked");
              },
              () => {
                if (!controller.signal.aborted) setOwnBlock(false);
              }
            );
          else setOwnBlock(false);
        }
      },
      () => {
        if (!controller.signal.aborted) {
          permissionRead.current = "failed";
          setCheckingPermission(false);
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
  }, [kind, id, changed, attempt, active, revision]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      held.current = null;
    };
  }, []);
  useEffect(() => {
    if (
      !held.current ||
      checkingPermission ||
      permissionRead.current === "reading"
    )
      return;
    const intent = held.current;
    held.current = null;
    setHolding(false);
    if (permissionFailed || permissionRead.current === "failed") {
      editor.current?.focus();
      return;
    }
    if (canMessage !== true) {
      title.current?.focus();
      return;
    }
    void send(intent.body);
  }, [holding, checkingPermission, permissionFailed, canMessage]);
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
  function pressSend() {
    if (
      (!body.trim() && !pending.current) ||
      posting.current ||
      held.current ||
      permissionFailed ||
      permissionRead.current === "failed"
    )
      return;
    if (checkingPermission || permissionRead.current === "reading") {
      if (!pending.current && canMessage !== true) return;
      if (!pending.current && Array.from(body).length > 4000) {
        setMessage(MESSAGE_LENGTH_TEXT);
        return;
      }
      held.current = { body: pending.current?.body ?? body };
      setHolding(true);
      setMessage("");
      return;
    }
    void send();
  }
  async function send(heldBody = body) {
    if (
      busy ||
      posting.current ||
      checkingPermission ||
      permissionRead.current !== "ready" ||
      permissionFailed ||
      (!pending.current && canMessage !== true)
    )
      return;
    if (!pending.current && Array.from(heldBody).length > 4000) {
      setMessage(MESSAGE_LENGTH_TEXT);
      return;
    }
    const command = pending.current ?? {
      body: heldBody,
      idempotency_key: crypto.randomUUID(),
    };
    pending.current = command;
    posting.current = true;
    setBusy(true);
    setMessage("");
    const release = () => {
      if (
        currentPermission.current === false &&
        editor.current?.form?.contains(document.activeElement)
      )
        title.current?.focus();
      pending.current = null;
    };
    try {
      await sendThreadMessage(kind, id, command);
      if (!alive.current) return;
      release();
      setBody("");
      setAttempt((n) => n + 1);
      poll();
    } catch (cause) {
      if (!alive.current) return;
      if (cause instanceof SocialError && cause.status < 500) {
        release();
        setMessage(threadMessageError(cause));
      } else setMessage("The answer was lost. Retry sends the same message.");
    } finally {
      posting.current = false;
      if (alive.current) {
        // Keep focus in the composer only if the collector stayed there.
        // Do this before rendering an empty draft or removing a closed chat.
        if (editor.current?.form?.contains(document.activeElement)) {
          if (currentPermission.current === false && !pending.current)
            title.current?.focus();
          else editor.current?.focus();
        }
        setBusy(false);
      }
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
        {moderation && (
          <ThreadMenu
            target={moderation.target}
            canMessage={canMessage === true}
            canReport={moderation.canReport}
            offerId={moderation.offerId}
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
            {timelineText(item, log!.you_are, name, editionNames, kind)}
          </li>
        ))}
      </ol>
      {canMessage || pending.current ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            pressSend();
          }}
          className="flex flex-col gap-2"
        >
          <TextArea
            ref={editor}
            label={`Message ${name}`}
            aria-describedby={finePointer ? hintId : undefined}
            onKeyDown={(event) => {
              if (
                event.key !== "Enter" ||
                !(event.ctrlKey || event.metaKey) ||
                event.nativeEvent.isComposing ||
                event.repeat
              )
                return;
              event.preventDefault();
              pressSend();
            }}
            value={body}
            readOnly={busy || holding || pending.current !== null}
            onChange={(event) => {
              if (!held.current && !pending.current)
                setBody(event.target.value);
            }}
          />
          {finePointer && (
            <p id={hintId} className="m-0 text-meta text-text-muted">
              {shortcut}
            </p>
          )}
          <Button
            type="submit"
            aria-disabled={
              busy ||
              holding ||
              (checkingPermission && canMessage !== true && !pending.current) ||
              permissionFailed ||
              (!body.trim() && !pending.current)
            }
          >
            {busy || holding ? "Sending…" : pending.current ? "Retry" : "Send"}
          </Button>
        </form>
      ) : canMessage === false ? (
        <p>This collector is no longer available</p>
      ) : null}
      {(checkingPermission || permissionFailed) && (
        <p role="status">
          {permissionFailed ? "Chat couldn't be checked." : "Checking chat…"}{" "}
          <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
        </p>
      )}
      {message && <p role="alert">{message}</p>}
    </section>
  );
}

/** Thread identity owns the chat draft/hold; changing items cannot release an old intent. */
export function ThreadTimeline(
  props: Parameters<typeof ThreadTimelineContent>[0]
) {
  return <ThreadTimelineContent key={`${props.kind}:${props.id}`} {...props} />;
}
