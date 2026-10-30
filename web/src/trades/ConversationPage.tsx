import { Avatar } from "../ui/Avatar";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from "react";
import { ChevronLeft } from "lucide-react";
import {
  usePollPulse,
  usePulseChanged,
  useConversationOpen,
  useTradesChanged,
} from "../inbox/Inbox";
import { inboxTime } from "../inbox/inboxTime";
import { PageHeader } from "../shell/PageHeader";
import {
  getConversation,
  getTraderConversation,
  readConversation,
  sendMessage,
  sendTraderMessage,
  SocialError,
  type ConversationView,
  type TimelineItem,
} from "../social_generated";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import type { MenuItem } from "../ui/Menu";
import { TextArea } from "../ui/TextField";
import { AddAsFriend, newestAddFriendTrade } from "./AddAsFriend";
import {
  COMPOSER_LABEL,
  COMPOSER_SEND,
  CONVERSATION_BACK,
  CONVERSATION_FAILED,
  CONVERSATION_LOADING,
  CONVERSATION_MISSING,
  CONVERSATION_MISSING_HEADING,
  EARLIER_FAILED,
  messageError,
  MESSAGE_LIMIT,
  MESSAGE_TOO_LONG,
  RETRY,
  SENDER_YOU,
  SHOW_EARLIER,
  SUSPENDED_NOTE,
  TIMELINE_LABEL,
  UNAVAILABLE_NOTE,
  youBlocked,
} from "./conversationMessages";
import { ConversationMenu, focusMenuTrigger } from "./ConversationMenu";
import { useMessagePrefill } from "./messagePrefill";
import { TradeCardLink } from "./TradeCardLink";
import {
  friendTradeListPath,
  proposalPath,
  TRADES_PATH,
  tradePath,
  traderTradeListPath,
} from "./tradeListModel";
import { traderMeta } from "./traderMessages";
import { useTraderBlock } from "./TraderBlock";
import { useTraderReport } from "./TraderReport";

/** Which conversation to show: the one with a collector (by trader id), or one by its id. */
export type ConversationTarget =
  { traderId: string } | { conversationId: string };

type Load =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "missing" }
  | {
      kind: "ready";
      view: ConversationView;
      /** Newest first, as the API sends them. */
      items: TimelineItem[];
      nextBefore: string | null;
      /** Whether older pages were loaded after the newest one. */
      older: boolean;
    };

const FRAME =
  "mx-auto box-border flex w-full min-w-0 max-w-5xl flex-col gap-6 px-7 py-7 phone:px-4 phone:py-5";
const BACK =
  "inline-flex h-control items-center gap-1 self-start rounded-control px-2 text-control font-medium text-text-muted no-underline hover:bg-surface-raised hover:text-text phone:h-control-phone";
const LINK =
  "inline-flex h-control items-center rounded-control px-2 text-control font-medium text-accent-strong no-underline hover:bg-surface-raised phone:h-control-phone";

function itemKey(item: TimelineItem): string {
  return `${item.kind}:${item.kind === "message" ? item.message?.id : item.trade?.id}`;
}

/**
 * One conversation (Trading #298), at /trades/with/<trader id> or /trades/conversation/<conversation id>: the other
 * collector's name and track record, their Trade List and **Propose trade** for a Friend, a line when the
 * conversation is read-only, then the messages and the pair's Trade rounds as inline cards, oldest first, and the
 * composer. A conversation that does not exist yet (a Friend with no messages) shows the empty composer; the first
 * message opens it. Messages are plain text. The newest page is read again when the pulse's watermark moves, after a
 * send, and after a Friend command that may have cancelled Trades; it is marked read through its newest item while the
 * page is visible. **Show earlier** adds the next older page. The page asks the shell for the fast pulse while mounted.
 * The header's ⋯ menu offers Block (Trading #302) unless the reader already blocked them, and Report (#303) in every
 * state where the other can be reported.
 */
export function ConversationPage({
  target,
  onNavigate,
}: {
  target: ConversationTarget;
  onNavigate: (to: string) => void;
}) {
  useConversationOpen();
  const pollPulse = usePollPulse();
  const pulseChanged = usePulseChanged();
  const tradesChanged = useTradesChanged();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [earlier, setEarlier] = useState<"idle" | "loading" | "failed">("idle");
  const prefill = useMessagePrefill();
  const [draft, setDraft] = useState(prefill);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [seen, setSeen] = useState(0);
  const key = useRef(crypto.randomUUID());
  const lastRead = useRef<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const menuAnchor = useRef<HTMLDivElement>(null);
  const shown = load.kind === "ready" ? load.view : null;
  const block = useTraderBlock(
    shown && shown.status !== "you_blocked" && shown.other.trader_id
      ? {
          traderId: shown.other.trader_id,
          name: shown.other.display_name,
          handle: shown.other.friend ? shown.other.handle : null,
        }
      : null,
    {
      onBlocked: () => heading.current?.focus(),
      returnFocus: () => focusMenuTrigger(menuAnchor),
    }
  );
  const report = useTraderReport(
    shown && shown.can_report && shown.other.trader_id
      ? {
          traderId: shown.other.trader_id,
          name: shown.other.display_name,
          handle: shown.other.friend ? shown.other.handle : null,
        }
      : null,
    {
      source: "conversation",
      onReported: () => heading.current?.focus(),
      returnFocus: () => focusMenuTrigger(menuAnchor),
    }
  );
  const traderId = "traderId" in target ? target.traderId : null;
  const conversationId =
    "conversationId" in target ? target.conversationId : "";

  const read = (before?: string | null, signal?: AbortSignal) =>
    traderId !== null
      ? getTraderConversation(traderId, { before }, signal)
      : getConversation(conversationId, { before }, signal);

  const reread = (signal?: AbortSignal) =>
    read(undefined, signal).then(
      (fresh) => {
        if (signal?.aborted) return;
        setLoad((current) => {
          if (current.kind !== "ready")
            return {
              kind: "ready",
              view: fresh,
              items: fresh.items,
              nextBefore: fresh.next_before,
              older: false,
            };
          const known = new Set(fresh.items.map(itemKey));
          const overlap = current.items.some((item) =>
            known.has(itemKey(item))
          );
          if (!overlap)
            return {
              kind: "ready",
              view: fresh,
              items: fresh.items,
              nextBefore: fresh.next_before,
              older: false,
            };
          return {
            kind: "ready",
            view: fresh,
            items: [
              ...fresh.items,
              ...current.items.filter((item) => !known.has(itemKey(item))),
            ],
            nextBefore: current.older ? current.nextBefore : fresh.next_before,
            older: current.older,
          };
        });
      },
      (cause: unknown) => {
        if (signal?.aborted) return;
        if (
          cause instanceof SocialError &&
          cause.code === "CONVERSATION_NOT_FOUND"
        )
          setLoad({ kind: "missing" });
        else
          setLoad((current) =>
            current.kind === "ready" ? current : { kind: "failed" }
          );
      }
    );

  useEffect(() => {
    const controller = new AbortController();
    void reread(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, pulseChanged, tradesChanged]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") setSeen((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // Marks the conversation read through its newest item once that is on screen and the page is visible.
  useEffect(() => {
    if (load.kind !== "ready" || !load.view.id || load.items.length === 0)
      return;
    if (document.visibilityState !== "visible") return;
    const newest = load.items[0];
    const newestKey = itemKey(newest);
    if (lastRead.current === newestKey) return;
    lastRead.current = newestKey;
    readConversation(load.view.id, { through: newest.cursor }).then(
      () => pollPulse(),
      () => {
        // The next newest item tries again.
        lastRead.current = null;
      }
    );
  }, [load, seen, pollPulse]);

  const showEarlier = async () => {
    if (load.kind !== "ready" || !load.nextBefore) return;
    setEarlier("loading");
    try {
      const page = await read(load.nextBefore);
      setLoad((current) =>
        current.kind === "ready"
          ? {
              ...current,
              items: [
                ...current.items,
                ...page.items.filter(
                  (item) =>
                    !current.items.some((old) => itemKey(old) === itemKey(item))
                ),
              ],
              nextBefore: page.next_before,
              older: true,
            }
          : current
      );
      setEarlier("idle");
    } catch {
      setEarlier("failed");
    }
  };

  const back = (
    <a
      href={TRADES_PATH}
      onClick={(event: MouseEvent) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        onNavigate(TRADES_PATH);
      }}
      className={BACK}
    >
      <Icon icon={ChevronLeft} />
      {CONVERSATION_BACK}
    </a>
  );
  const go = (to: string) => (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    onNavigate(to);
  };

  if (load.kind === "loading")
    return (
      <main className={FRAME}>
        {back}
        <p role="status" className="m-0 text-body text-text-muted">
          {CONVERSATION_LOADING}
        </p>
      </main>
    );
  if (load.kind === "failed")
    return (
      <main className={FRAME}>
        {back}
        <div className="flex flex-wrap items-center gap-3">
          <p role="status" className="m-0 text-body text-text-muted">
            {CONVERSATION_FAILED}
          </p>
          <Button
            onClick={() => {
              setLoad({ kind: "loading" });
              setAttempt((n) => n + 1);
            }}
          >
            {RETRY}
          </Button>
        </div>
      </main>
    );
  if (load.kind === "missing")
    return (
      <main className={FRAME}>
        {back}
        <PageHeader title={CONVERSATION_MISSING_HEADING} />
        <p className="m-0 text-body text-text-muted">{CONVERSATION_MISSING}</p>
      </main>
    );

  const { view, items } = load;
  const other = view.other;
  const name = other.display_name;
  const addFriendTrade = newestAddFriendTrade(items);
  const record = traderMeta(other.band, other.completed_trades);
  // Where the other side's Trade List is: a Friend's page by Handle, anyone else's by trader id. Nowhere once the
  // conversation is not open or the other side has no trader id.
  const listTo =
    other.trader_id === null || view.status !== "open"
      ? null
      : other.friend && other.handle
        ? friendTradeListPath(other.handle)
        : traderTradeListPath(other.trader_id);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (sending || draft.trim() === "") return;
    if ([...draft].length > MESSAGE_LIMIT) {
      setNotice(MESSAGE_TOO_LONG);
      return;
    }
    setSending(true);
    setNotice(null);
    const body = { body: draft, idempotency_key: key.current };
    try {
      if (view.id) await sendMessage(view.id, body);
      else await sendTraderMessage(traderId ?? "", body);
      setDraft("");
      key.current = crypto.randomUUID();
      await reread();
      pollPulse();
      area.current?.focus();
    } catch (cause) {
      const text = messageError(cause);
      if (text === "reread") {
        setNotice(null);
        await reread();
      } else setNotice(text);
    } finally {
      setSending(false);
    }
  };

  const menuItems = [block.item, report.item].filter(
    (item): item is MenuItem => item !== null
  );

  return (
    <main className={FRAME}>
      {back}
      <div className="flex min-w-0 items-center gap-3">
        <Avatar name={name} size="md" />
        <div className="min-w-0 flex-1 [&>div]:mb-0 [&>div]:flex-nowrap [&>div]:items-start [&_h1]:min-w-0 [&_h1]:flex-1 phone:[&>div>div]:basis-auto">
          <PageHeader
            title={name}
            headingRef={heading}
            actions={
              menuItems.length > 0 ? (
                <ConversationMenu
                  name={name}
                  items={menuItems}
                  anchor={menuAnchor}
                />
              ) : undefined
            }
          />
        </div>
      </div>
      {block.panel}
      {report.panel}
      {record !== null && (
        <p className="m-0 text-meta text-text-muted">{record}</p>
      )}
      {listTo !== null && (
        <div className="flex flex-wrap items-center gap-3">
          {view.can_propose && other.trader_id !== null && (
            <Button
              variant="primary"
              aria-label={`Propose trade to ${name}`}
              onClick={() => onNavigate(proposalPath(other.trader_id!))}
            >
              Propose trade
            </Button>
          )}
          <a href={listTo} onClick={go(listTo)} className={LINK}>
            See all of {name}'s Trade List
          </a>
        </div>
      )}
      {view.status === "you_blocked" ? (
        <p className="m-0 text-body">
          <a
            href="/settings"
            onClick={go("/settings")}
            className="text-accent-strong"
          >
            {youBlocked(name)}
          </a>
        </p>
      ) : view.status === "unavailable" ? (
        <p className="m-0 text-body text-text-muted">{UNAVAILABLE_NOTE}</p>
      ) : (
        !view.can_message && (
          <p className="m-0 text-body text-text-muted">{SUSPENDED_NOTE}</p>
        )
      )}
      {load.nextBefore && (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={showEarlier} disabled={earlier === "loading"}>
            {SHOW_EARLIER}
          </Button>
          {earlier === "failed" && (
            <p role="alert" className="m-0 text-meta text-danger">
              {EARLIER_FAILED}
            </p>
          )}
        </div>
      )}
      {items.length > 0 && (
        <ol
          aria-label={TIMELINE_LABEL}
          className="m-0 flex list-none flex-col gap-3 p-0"
        >
          {[...items].reverse().map((item) =>
            item.kind === "trade" && item.trade ? (
              <li
                key={itemKey(item)}
                className="overflow-hidden rounded-panel border border-border bg-surface"
              >
                <TradeCardLink
                  trade={item.trade}
                  onOpenTrade={(id) => onNavigate(tradePath(id))}
                />
                {item.trade.id === addFriendTrade && (
                  <AddAsFriend
                    tradeId={item.trade.id}
                    traderId={item.trade.other.trader_id!}
                    name={name}
                    className="border-t border-border px-4 py-3"
                  />
                )}
              </li>
            ) : item.message ? (
              <li
                key={itemKey(item)}
                className={`flex max-w-[85%] flex-col gap-1 rounded-panel border border-border px-4 py-3 ${
                  item.message.from === "you"
                    ? "self-end bg-surface-raised"
                    : "self-start bg-surface"
                }`}
              >
                <p className="m-0 whitespace-pre-wrap wrap-anywhere">
                  {item.message.body}
                </p>
                <span className="text-meta text-text-muted">
                  <span>{item.message.from === "you" ? SENDER_YOU : name}</span>
                  {" · "}
                  <time dateTime={item.message.at}>
                    {inboxTime(item.message.at, Date.now())}
                  </time>
                </span>
              </li>
            ) : null
          )}
        </ol>
      )}
      {view.can_message && (
        <form onSubmit={send} className="flex flex-col gap-2">
          <TextArea
            ref={area}
            label={COMPOSER_LABEL}
            rows={3}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setNotice(null);
            }}
          />
          {notice && (
            <p role="alert" className="m-0 text-meta text-danger">
              {notice}
            </p>
          )}
          <div>
            <Button
              type="submit"
              variant="primary"
              disabled={sending || draft.trim() === ""}
            >
              {COMPOSER_SEND}
            </Button>
          </div>
        </form>
      )}
    </main>
  );
}
