import {
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { lineEdition } from "../loans/loanText";
import { PageHeader } from "../shell/PageHeader";
import { CardImage } from "../social/FriendCollectionPage";
import {
  getTradeMatch,
  type TradeMatchCard,
  type TradeMatchRow,
} from "../social_generated";
import { sendTradeProposal } from "../trades_generated";
import { Button } from "../ui/Button";
import { Stepper } from "../ui/Stepper";
import { useToast } from "../ui/Toast";
import {
  useTradeDraft,
  type TradeDraft,
  type TradeDraftLine,
  type TradeDraftSide,
} from "./TradeDraft";
import {
  friendTradeListPath,
  TRADE_LIST_PATH,
  tradePath,
} from "./tradeListModel";
import { suggestedQuantity, wantText } from "./tradeMatchText";
import {
  sendTradeMessage,
  tradeCardName,
  tradeOutcomeUnknown,
} from "./tradeText";

const LINK =
  "inline-flex h-control items-center rounded-control px-2 text-control font-medium text-accent-strong no-underline hover:bg-surface-raised phone:h-control-phone";

/**
 * The Trade Proposal draft (Trading #270, prototype verdict variant A), at /trades/draft: **You give** and **You get**,
 * each line with a stepper up to what that side's Trade List showed, links to add from either Trade List, **Send
 * Trade Proposal** and **Discard draft**. Sending reserves the cards the collector gives; until then nothing is
 * promised. A refused send keeps the draft and says which card and how many are on the Trade List now; a sent one
 * clears the draft and opens the Trade.
 *
 * **Suggested** (Trading #276, owner's verdict 2026-10-19): at the top of each side, the cards Find trades matches
 * between the collector and the draft's Friend now, read again each time the page opens, each added with one tap
 * (as many as are wanted, up to the copies offered). A card already on either side of the draft isn't suggested.
 * Nothing shows while the read is out or when it fails: the draft is complete without it.
 */
export function TradeDraftPage({
  onNavigate,
}: {
  onNavigate: (to: string) => void;
}) {
  const drafts = useTradeDraft();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const suggested = useSuggestions(drafts?.draft?.friend.collector_id ?? null);

  // The page shows the draft itself, so the bar stays down while it is open. setBarHidden is a state setter: stable.
  const hideBar = drafts?.setBarHidden;
  useEffect(() => {
    hideBar?.(true);
    return () => hideBar?.(false);
  }, [hideBar]);

  const frame = (title: string, children: ReactNode) => (
    <main className="mx-auto box-border flex max-w-5xl flex-col gap-5 px-7 py-7 phone:px-4 phone:py-5">
      <PageHeader title={title} />
      {children}
    </main>
  );

  const draft = drafts?.draft ?? null;
  if (!drafts || !draft)
    return frame(
      "Trade Proposal",
      <p className="m-0 text-body text-text-muted">
        You have no Trade Proposal draft. Open a Friend's Trade List and add a
        card to start one.
      </p>
    );

  const name = draft.friend.display_name;
  const empty = draft.give.length === 0 && draft.get.length === 0;

  const go = (to: string) => (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    onNavigate(to);
  };

  async function send(current: TradeDraft) {
    if (busy || !drafts) return;
    setBusy(true);
    setMessage("");
    try {
      const trade = await sendTradeProposal({
        recipient_id: current.friend.collector_id,
        you_give: current.give.map((line) => ({
          edition_id: line.edition_id,
          quantity: String(line.quantity),
        })),
        you_get: current.get.map((line) => ({
          edition_id: line.edition_id,
          quantity: String(line.quantity),
        })),
        idempotency_key: drafts.sendKey(),
      });
      drafts.discard();
      toast.show({ message: `Trade Proposal sent to ${name}` });
      onNavigate(tradePath(trade.id));
    } catch (cause) {
      // A refusal is final for this key; an unknown outcome keeps it, so the retry is the same send.
      if (!tradeOutcomeUnknown(cause)) drafts.forgetKey();
      setMessage(sendTradeMessage(cause, name, current.give, current.get));
    } finally {
      setBusy(false);
    }
  }

  const handle = draft.friend.handle;
  return frame(
    `Trade Proposal to ${name}`,
    <>
      <div className="grid grid-cols-2 items-start gap-4 phone:grid-cols-1">
        <DraftSide
          title="You give"
          side="give"
          draft={draft}
          suggestions={suggested?.you_give ?? []}
          add={
            <a
              href={TRADE_LIST_PATH}
              onClick={go(TRADE_LIST_PATH)}
              className={LINK}
            >
              Add from your Trade List
            </a>
          }
        />
        <DraftSide
          title="You get"
          side="get"
          draft={draft}
          suggestions={suggested?.you_get ?? []}
          add={
            handle ? (
              <a
                href={friendTradeListPath(handle)}
                onClick={go(friendTradeListPath(handle))}
                className={LINK}
              >
                Add from {name}'s Trade List
              </a>
            ) : null
          }
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          disabled={empty}
          aria-disabled={busy || undefined}
          onClick={() => void send(draft)}
        >
          Send Trade Proposal
        </Button>
        {empty && (
          <span className="text-meta text-text-muted">
            Add at least one card to either side.
          </span>
        )}
        <Button variant="quiet" onClick={() => drafts.discard()}>
          Discard draft
        </Button>
      </div>
      <p role="alert" className="m-0 text-meta text-danger empty:hidden">
        {message}
      </p>
    </>
  );
}

/** The draft Friend's discovery row (Find trades' per-Friend read), for the suggestions; null while it is out, when it
 * fails (a Friend no longer, say) or for no Friend. Aborted when the page closes or the draft's Friend changes. */
function useSuggestions(friendId: string | null): TradeMatchRow | null {
  const [answer, setAnswer] = useState<{
    friendId: string;
    row: TradeMatchRow;
  } | null>(null);
  useEffect(() => {
    if (!friendId) return;
    const controller = new AbortController();
    getTradeMatch(friendId, controller.signal).then(
      (row) => {
        if (!controller.signal.aborted) setAnswer({ friendId, row });
      },
      () => {
        if (!controller.signal.aborted) setAnswer(null);
      }
    );
    return () => controller.abort();
  }, [friendId]);
  return answer && answer.friendId === friendId ? answer.row : null;
}

/** One side of the draft: Suggested (the matched cards on neither side yet), its lines with steppers (0 takes a line
 * out), "Nothing yet" when empty, and its Add link. */
function DraftSide({
  title,
  side,
  draft,
  suggestions,
  add,
}: {
  title: string;
  side: TradeDraftSide;
  draft: TradeDraft;
  suggestions: TradeMatchCard[];
  add: ReactNode;
}) {
  const headingId = useId();
  const suggestedId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const drafts = useTradeDraft();
  const lines = draft[side];
  // A card can't be on both sides of a Trade, so one on either side already isn't suggested.
  const taken = new Set(
    [...draft.give, ...draft.get].map((line) => line.edition_id)
  );
  const offered = suggestions.filter((card) => !taken.has(card.edition_id));
  const verb = side === "give" ? "give" : "get";
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-2"
    >
      <h2
        ref={heading}
        id={headingId}
        tabIndex={-1}
        className="m-0 text-heading font-semibold"
      >
        {title}
      </h2>
      {drafts && offered.length > 0 && (
        <div className="flex min-w-0 flex-col gap-1">
          <h3
            id={suggestedId}
            className="m-0 text-meta font-semibold text-text-muted"
          >
            Suggested
          </h3>
          <ul
            aria-label={`Suggested to ${verb}`}
            className="m-0 list-none overflow-hidden rounded-panel border border-dashed border-border-strong bg-surface p-0"
          >
            {offered.map((card) => (
              <li
                key={card.edition_id}
                className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
              >
                <CardImage url={card.image_url} />
                <span className="flex min-w-0 flex-col">
                  <span className="text-body font-semibold wrap-anywhere">
                    {card.name}
                  </span>
                  <span className="text-meta text-text-muted tabular-nums wrap-anywhere">
                    {lineEdition(card)}
                  </span>
                  <span className="text-meta text-text-subtle tabular-nums">
                    ×{card.copies} · {wantText(card)}
                  </span>
                </span>
                <Button
                  aria-label={`Add ${tradeCardName(card)} to what you ${verb}`}
                  onClick={() => {
                    drafts.set(
                      draft.friend,
                      side,
                      card,
                      suggestedQuantity(card),
                      Number(card.copies)
                    );
                    // The button leaves with its suggestion: focus goes to the side's heading, above the new line.
                    heading.current?.focus();
                  }}
                >
                  Add
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <ul
        aria-label={title}
        className="m-0 list-none overflow-hidden rounded-panel border border-border bg-surface p-0"
      >
        {lines.length === 0 ? (
          <li className="px-4 py-3 text-body text-text-muted">Nothing yet</li>
        ) : (
          lines.map((line) => (
            <DraftLineRow
              key={line.edition_id}
              line={line}
              side={side}
              draft={draft}
            />
          ))
        )}
      </ul>
      {add && <div>{add}</div>}
    </section>
  );
}

function DraftLineRow({
  line,
  side,
  draft,
}: {
  line: TradeDraftLine;
  side: TradeDraftSide;
  draft: TradeDraft;
}) {
  const drafts = useTradeDraft();
  return (
    <li className="grid grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
      <CardImage url={line.image_url} />
      <span className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 flex-col">
          <span className="text-body font-semibold wrap-anywhere">
            {line.name}
          </span>
          <span className="text-meta text-text-muted tabular-nums wrap-anywhere">
            {lineEdition(line)}
          </span>
          <span className="text-meta text-text-subtle tabular-nums">
            Up to {line.cap}
          </span>
        </span>
        <Stepper
          label={`${tradeCardName(line)} ${side === "give" ? "you give" : "you get"}`}
          value={line.quantity}
          min={0}
          max={Math.max(line.cap, line.quantity)}
          onChange={(value) =>
            drafts?.set(draft.friend, side, line, value, line.cap)
          }
        />
      </span>
    </li>
  );
}
