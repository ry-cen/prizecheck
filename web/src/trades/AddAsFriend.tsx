import { useCallback, useEffect, useRef, useState } from "react";
import { useFriendsRefresh } from "../social/FriendsDrawer";
import {
  addFriendFromTrade,
  getTrader,
  withdrawAddFriend,
  type FriendCommand,
  type FriendCommandResult,
  type TimelineItem,
  type TraderView,
  type TradeView,
} from "../social_generated";
import { Button } from "../ui/Button";
import {
  ACCEPT_ADD_FRIEND,
  ADD_FRIEND,
  ADD_FRIEND_WITHDRAWN,
  WITHDRAW_ADD_FRIEND,
  addFriendError,
  addFriendReceivedNote,
  addFriendSentNote,
  addFriendSentStatus,
  friendsNow,
  withdrawAddFriendLabel,
} from "./addFriendMessages";

// Add as Friend (Trading #304) on a Trade both sides confirmed with someone who is not a Friend. It reads the other
// side's trader header by trader id to learn the request's state, and a failed read shows nothing.

/** True when this Trade can offer Add as Friend: both confirmed, the other is not a Friend and is still available. */
export function showsAddFriend(trade: TradeView): boolean {
  return (
    trade.you_confirmed_swap === true &&
    trade.they_confirmed_swap === true &&
    !trade.other.friend &&
    trade.other.available === true &&
    trade.other.trader_id != null
  );
}

/** The id of the newest Trade in a conversation (items are newest first) that can offer Add as Friend. */
export function newestAddFriendTrade(items: TimelineItem[]): string | null {
  for (const item of items) {
    if (item.kind === "trade" && item.trade && showsAddFriend(item.trade))
      return item.trade.id;
  }
  return null;
}

type Shown = TraderView["add_friend"] | "loading";

export function AddAsFriend({
  tradeId,
  traderId,
  name,
  className,
}: {
  tradeId: string;
  traderId: string;
  name: string;
  className?: string;
}) {
  const refreshFriends = useFriendsRefresh();
  const [shown, setShown] = useState<Shown>("loading");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [problem, setProblem] = useState("");
  const reads = useRef(0);
  const button = useRef<HTMLButtonElement>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);
  const shownNow = useRef<Shown>("loading");
  // Where focus goes once the state a command changed has been read: the new button, or the status line when none is left.
  const focusAfter = useRef<"button" | "status" | null>(null);

  const read = useCallback(
    async (signal?: AbortSignal) => {
      const mine = ++reads.current;
      try {
        const header = await getTrader(traderId, signal);
        if (mine === reads.current) {
          if (header.add_friend === shownNow.current) focusAfter.current = null;
          shownNow.current = header.add_friend;
          setShown(header.add_friend);
        }
      } catch {
        if (mine === reads.current) {
          focusAfter.current = null;
          setShown((current) => {
            const next = current === "loading" ? null : current;
            shownNow.current = next;
            return next;
          });
        }
      }
    },
    [traderId]
  );

  useEffect(() => {
    const controller = new AbortController();
    shownNow.current = "loading";
    setShown("loading");
    setStatus("");
    setProblem("");
    void read(controller.signal);
    const onFocus = () => void read();
    window.addEventListener("focus", onFocus);
    return () => {
      controller.abort();
      window.removeEventListener("focus", onFocus);
    };
  }, [read]);

  useEffect(() => {
    if (focusAfter.current && shown !== "loading") {
      const target = focusAfter.current;
      focusAfter.current = null;
      (target === "status" || !button.current
        ? statusLine.current
        : button.current
      )?.focus();
    }
  }, [shown]);

  async function run(
    send: (body: FriendCommand) => Promise<FriendCommandResult>,
    done: (relation: FriendCommandResult["relation"]) => string
  ) {
    if (busy) return;
    setBusy(true);
    setStatus("");
    setProblem("");
    try {
      const result = await send({ idempotency_key: crypto.randomUUID() });
      setStatus(done(result.relation));
      focusAfter.current = result.relation === "friends" ? "status" : "button";
      refreshFriends();
    } catch (cause) {
      setProblem(addFriendError(cause));
    }
    setBusy(false);
    void read();
  }

  const add = () =>
    run(
      (body) => addFriendFromTrade(tradeId, body),
      (relation) =>
        relation === "friends"
          ? friendsNow(name)
          : relation === "request_sent"
            ? addFriendSentStatus(name)
            : ""
    );

  if (shown === "loading") return null;
  if (shown === null && !status && !problem) return null;

  return (
    <div className={`flex flex-col gap-2${className ? ` ${className}` : ""}`}>
      {shown === "offer" && (
        <div className="flex flex-wrap items-center gap-2">
          <Button ref={button} aria-disabled={busy || undefined} onClick={add}>
            {ADD_FRIEND}
          </Button>
        </div>
      )}
      {shown === "sent" && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="m-0 min-w-0 flex-1 text-body">
            {addFriendSentNote(name)}
          </p>
          <Button
            ref={button}
            variant="quiet"
            aria-label={withdrawAddFriendLabel(name)}
            aria-disabled={busy || undefined}
            onClick={() =>
              run(
                (body) => withdrawAddFriend(tradeId, body),
                (relation) =>
                  relation === "none"
                    ? ADD_FRIEND_WITHDRAWN
                    : relation === "friends"
                      ? friendsNow(name)
                      : ""
              )
            }
          >
            {WITHDRAW_ADD_FRIEND}
          </Button>
        </div>
      )}
      {shown === "received" && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="m-0 min-w-0 flex-1 text-body">
            {addFriendReceivedNote(name)}
          </p>
          <Button
            ref={button}
            variant="primary"
            aria-disabled={busy || undefined}
            onClick={add}
          >
            {ACCEPT_ADD_FRIEND}
          </Button>
        </div>
      )}
      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="m-0 text-meta text-text-muted empty:hidden"
      >
        {status}
      </p>
      <p role="alert" className="m-0 text-meta text-danger empty:hidden">
        {problem}
      </p>
    </div>
  );
}
