import { useEffect, useState, type MouseEvent } from "react";
import {
  usePollPulse,
  usePulseChanged,
  useTradesChanged,
} from "../inbox/Inbox";
import { inboxTime } from "../inbox/inboxTime";
import {
  archiveConversation,
  getConversations,
  unarchiveConversation,
  type ConversationSummary,
} from "../social_generated";
import { Button } from "../ui/Button";
import {
  ARCHIVE,
  ARCHIVE_FAILED,
  archiveLabel,
  HIDE_ARCHIVED,
  LIST_ARCHIVED_EMPTY,
  LIST_EMPTY,
  LIST_FAILED,
  LIST_LABEL,
  LIST_LOADING,
  needsYouText,
  openTradesText,
  PREVIEW_YOU,
  RETRY,
  SHOW_ARCHIVED,
  SHOW_MORE,
  SUSPENDED_NOTE,
  UNARCHIVE,
  UNREAD,
} from "./conversationMessages";
import { conversationHref } from "./tradeListModel";

type Load =
  | { kind: "loading" }
  | { kind: "failed" }
  | {
      kind: "ready";
      rows: ConversationSummary[];
      nextBefore: string | null;
      suspended: boolean;
    };

type More = "idle" | "loading" | "failed";

/**
 * The conversation list (Trading #298), the Trades tab's first view at /trades: one row per conversation, newest
 * activity first. A row is one link to its conversation, with the other collector's name, an unread marker, the last
 * message ("You: " before the reader's own), and a line of what waits ("1 needs you · 2 open Trades · 3 hours ago");
 * beside it the **Archive** button. **Archived conversations** switches to the archived ones, where the button reads
 * **Unarchive**. The list is read again when the pulse's watermark moves and after a Friend command that may have
 * cancelled Trades (`useTradesChanged`); **Show more conversations** appends the next page.
 */
export function ConversationList({
  onNavigate,
}: {
  onNavigate: (to: string) => void;
}) {
  const [archived, setArchived] = useState(false);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [more, setMore] = useState<More>("idle");
  const [notice, setNotice] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const pulseChanged = usePulseChanged();
  const pollPulse = usePollPulse();
  const tradesChanged = useTradesChanged();

  useEffect(() => {
    const controller = new AbortController();
    getConversations({ archived }, controller.signal).then(
      (view) => {
        if (controller.signal.aborted) return;
        setMore("idle");
        setLoad({
          kind: "ready",
          rows: view.conversations,
          nextBefore: view.next_before,
          suspended: view.suspended,
        });
      },
      () => {
        if (controller.signal.aborted) return;
        // A failed re-read leaves the list on screen.
        setLoad((current) =>
          current.kind === "ready" ? current : { kind: "failed" }
        );
      }
    );
    return () => controller.abort();
  }, [archived, attempt, pulseChanged, tradesChanged]);

  const switchList = () => {
    setArchived((value) => !value);
    setLoad({ kind: "loading" });
    setMore("idle");
    setNotice(false);
  };
  const toggle = (
    <Button onClick={switchList}>
      {archived ? HIDE_ARCHIVED : SHOW_ARCHIVED}
    </Button>
  );

  if (load.kind === "loading")
    return (
      <p role="status" className="m-0 text-body text-text-muted">
        {LIST_LOADING}
      </p>
    );
  if (load.kind === "failed")
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p role="status" className="m-0 text-body text-text-muted">
          {LIST_FAILED}
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
    );

  const { rows, nextBefore } = load;
  const showMore = async () => {
    if (!nextBefore) return;
    setMore("loading");
    try {
      const view = await getConversations({ archived, before: nextBefore });
      setLoad((current) =>
        current.kind === "ready"
          ? {
              kind: "ready",
              rows: [
                ...current.rows,
                ...view.conversations.filter(
                  (row) => !current.rows.some((old) => old.id === row.id)
                ),
              ],
              nextBefore: view.next_before,
              suspended: view.suspended,
            }
          : current
      );
      setMore("idle");
    } catch {
      setMore("failed");
    }
  };
  const change = async (row: ConversationSummary) => {
    setNotice(false);
    try {
      await (archived ? unarchiveConversation : archiveConversation)(row.id);
      pollPulse();
      setLoad((current) =>
        current.kind === "ready"
          ? { ...current, rows: current.rows.filter((r) => r.id !== row.id) }
          : current
      );
    } catch {
      setNotice(true);
    }
  };

  return (
    <>
      {load.suspended && (
        <p className="m-0 text-body text-text-muted">{SUSPENDED_NOTE}</p>
      )}
      {rows.length === 0 ? (
        <p className="m-0 text-body text-text-muted">
          {archived ? LIST_ARCHIVED_EMPTY : LIST_EMPTY}
        </p>
      ) : (
        <ul
          aria-label={LIST_LABEL}
          className="m-0 list-none overflow-hidden rounded-panel border border-border bg-surface p-0"
        >
          {rows.map((row) => (
            <ConversationRow
              key={row.id}
              row={row}
              archived={archived}
              onNavigate={onNavigate}
              onChange={() => change(row)}
            />
          ))}
        </ul>
      )}
      {notice && (
        <p role="alert" className="m-0 text-meta text-danger">
          {ARCHIVE_FAILED}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {nextBefore && (
          <Button onClick={showMore} disabled={more === "loading"}>
            {SHOW_MORE}
          </Button>
        )}
        {toggle}
      </div>
      {more === "failed" && (
        <p role="alert" className="m-0 text-meta text-danger">
          {LIST_FAILED}
        </p>
      )}
    </>
  );
}

function ConversationRow({
  row,
  archived,
  onNavigate,
  onChange,
}: {
  row: ConversationSummary;
  archived: boolean;
  onNavigate: (to: string) => void;
  onChange: () => void;
}) {
  const href = conversationHref(row);
  const name = row.other.display_name;
  const meta = [
    needsYouText(row.waiting_on_you),
    openTradesText(row.open_trades),
    inboxTime(row.last_activity_at, Date.now()),
  ]
    .filter((part) => part !== "")
    .join(" · ");
  return (
    <li className="flex items-center gap-2 border-b border-border pr-3 last:border-b-0">
      <a
        href={href}
        onClick={(event: MouseEvent) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey) return;
          event.preventDefault();
          onNavigate(href);
        }}
        className="flex min-h-tap min-w-0 flex-1 flex-col justify-center gap-0.5 px-4 py-3 text-text no-underline hover:bg-surface-raised"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="text-body font-semibold wrap-anywhere">{name}</span>
          {row.unread && (
            <>
              <span className="sr-only">{UNREAD}</span>
              <span
                aria-hidden="true"
                className="inline-block size-2 shrink-0 rounded-round bg-accent"
              />
            </>
          )}
        </span>
        {row.last_message && (
          <span className="truncate text-meta text-text-muted">
            {row.last_message.from === "you" ? PREVIEW_YOU : ""}
            {row.last_message.preview}
          </span>
        )}
        <span className="text-meta text-text-muted">{meta}</span>
      </a>
      <Button aria-label={archiveLabel(name, archived)} onClick={onChange}>
        {archived ? UNARCHIVE : ARCHIVE}
      </Button>
    </li>
  );
}
