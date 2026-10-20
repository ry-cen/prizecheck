import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronLeft, Ellipsis } from "lucide-react";
import { lineEdition } from "../loans/loanText";
import { PageHeader } from "../shell/PageHeader";
import { CardImage } from "../social/FriendCollectionPage";
import {
  cancelTrade,
  declineTrade,
  getTrade,
  SocialError,
  withdrawTrade,
  type TradeCard,
  type TradeStep,
  type TradeView,
} from "../social_generated";
import { acceptTrade, TradesError } from "../trades_generated";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { Menu, type MenuItem } from "../ui/Menu";
import { useToast } from "../ui/Toast";
import { TRADES_PATH } from "./tradeListModel";
import {
  tradeHeadline,
  tradeOutcomeUnknown,
  tradeStepMessage,
} from "./tradeText";

type Load =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "failed" }
  | { kind: "ready"; trade: TradeView };

/** The refusals that mean the Trade moved on: the screen reads it again. */
const RELOAD = new Set(["TRADE_CHANGED", "STEP_NOT_ALLOWED"]);

/** A step that asks first (owner, 2026-10-20): Decline, Withdraw and Cancel Trade end the Trade for both sides. */
type Asking = "decline" | "withdraw" | "cancel";

/** Where focus goes after the next render, when the control that had it goes away: the confirmation's own button when
 * it asks, its opener after Keep it (Decline, or ⋯ for Withdraw and Cancel Trade), and the heading after a step or a
 * refusal that reads the Trade again. */
type FocusNext = "ask" | "decline" | "menu" | "heading";

const ASK: Record<
  Asking,
  { question: (other: string) => string; yes: string }
> = {
  decline: {
    question: (other) => `Decline ${other}'s Trade Proposal?`,
    yes: "Decline",
  },
  withdraw: {
    question: (other) => `Withdraw your Trade Proposal to ${other}?`,
    yes: "Withdraw",
  },
  cancel: {
    question: (other) =>
      `Cancel this Trade with ${other}? None of these cards stay promised.`,
    yes: "Cancel Trade",
  },
};

/** What each step's toast says once it went through. */
const DONE: Record<Asking | "accept", string> = {
  accept: "Accepted. Swap the cards in person.",
  decline: "Declined",
  withdraw: "Withdrawn",
  cancel: "Trade cancelled",
};

/**
 * One Trade's screen (Trading #270, prototype verdict variant A), at /trades/<id>: the headline, who the Trade is
 * with, and two columns, **You give** and **You get** (one column on a phone), each card with its copies. A recipient
 * answers a proposal with **Accept** or **Decline** under the two sides (#271); the proposer withdraws it from **⋯**,
 * and either side cancels an accepted Trade nobody has confirmed from **⋯** (**Cancel Trade**). Decline, Withdraw and
 * Cancel Trade ask first, as the Loan steps that end a Loan do: the question replaces the answer buttons, with the
 * step's own button and **Keep it**, which puts focus back on the opener. Only the steps the Trade's `actions` list
 * show. It never names a Location or a Deck: where the collector's own cards are taken from joins with Confirm swap
 * (#272).
 */
export function TradeScreen({
  tradeId,
  onAllTrades,
}: {
  /** The Trade's id, or null for an address that names no Trade: it shows the same not-found as a missing Trade. */
  tradeId: string | null;
  onAllTrades: () => void;
}) {
  const toast = useToast();
  const [load, setLoad] = useState<Load>(
    tradeId === null ? { kind: "missing" } : { kind: "loading" }
  );
  const [attempt, setAttempt] = useState(0);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<Asking | null>(null);
  // One key per step until it settles, so a step whose outcome is unknown is retried safely.
  const keys = useRef(new Map<string, string>());
  const heading = useRef<HTMLHeadingElement>(null);
  const menuAnchor = useRef<HTMLDivElement>(null);
  const askButton = useRef<HTMLButtonElement>(null);
  const declineButton = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<FocusNext | null>(null);
  // A step refused because the Trade moved on reads it again: an open question closes and the heading takes focus
  // once the new Trade is drawn, so focus never lands on the old headline.
  const reloading = useRef(false);

  useEffect(() => {
    if (tradeId === null) return;
    const controller = new AbortController();
    getTrade(tradeId, controller.signal).then(
      (trade) => {
        if (controller.signal.aborted) return;
        if (reloading.current) {
          reloading.current = false;
          focusNext.current = "heading";
          setAsking(null);
        }
        setLoad({ kind: "ready", trade });
      },
      (cause) => {
        if (controller.signal.aborted) return;
        reloading.current = false;
        setLoad(
          cause instanceof SocialError && cause.status === 404
            ? { kind: "missing" }
            : { kind: "failed" }
        );
      }
    );
    return () => controller.abort();
  }, [tradeId, attempt]);

  // After each render: a focus move asked for by the last press or step (FocusNext).
  useLayoutEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    const element =
      target === "ask"
        ? askButton.current
        : target === "decline"
          ? declineButton.current
          : target === "menu"
            ? menuAnchor.current?.querySelector("button")
            : heading.current;
    element?.focus({ preventScroll: target === "heading" });
  });

  const back = (
    <a
      href={TRADES_PATH}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        onAllTrades();
      }}
      className="inline-flex h-control items-center gap-1 self-start rounded-control px-2 text-control font-medium text-text-muted no-underline hover:bg-surface-raised hover:text-text phone:h-control-phone"
    >
      <Icon icon={ChevronLeft} />
      All Trades
    </a>
  );
  const frame = (title: string, children: ReactNode, actions?: ReactNode) => (
    <main className="mx-auto box-border flex max-w-5xl flex-col gap-4 px-7 py-6 phone:px-4 phone:py-4">
      {back}
      <PageHeader title={title} actions={actions} headingRef={heading} />
      {children}
    </main>
  );

  if (load.kind === "loading")
    return frame(
      "Trade",
      <p role="status" className="m-0 text-body text-text-muted">
        Loading the Trade…
      </p>
    );
  if (load.kind === "missing")
    return frame(
      "Trade not found",
      <p className="m-0 text-body text-text-muted">
        This Trade can't be found.
      </p>
    );
  if (load.kind === "failed")
    return frame(
      "Trade",
      <div className="flex flex-wrap items-center gap-3">
        <p role="status" className="m-0 text-body text-text-muted">
          This Trade couldn't be loaded.
        </p>
        <Button
          onClick={() => {
            setLoad({ kind: "loading" });
            setAttempt((n) => n + 1);
          }}
        >
          Retry
        </Button>
      </div>
    );

  const { trade } = load;
  const name = trade.other.display_name;

  /** Asks before a step that ends the Trade, with focus on the confirmation's button. */
  function ask(step: Asking) {
    if (busy) return;
    setMessage("");
    focusNext.current = "ask";
    setAsking(step);
  }
  /** Runs one step: the answer replaces the Trade, the question closes and the heading takes focus. */
  async function step(
    action: Asking | "accept",
    call: (id: string, body: TradeStep) => Promise<TradeView>
  ) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    const key = keys.current.get(action) ?? crypto.randomUUID();
    keys.current.set(action, key);
    try {
      const next = await call(trade.id, {
        revision: trade.revision,
        idempotency_key: key,
      });
      keys.current.delete(action);
      focusNext.current = "heading";
      setAsking(null);
      setLoad({ kind: "ready", trade: next });
      toast.show({ message: DONE[action] });
    } catch (cause) {
      if (!tradeOutcomeUnknown(cause)) keys.current.delete(action);
      setMessage(tradeStepMessage(cause, trade));
      if (
        (cause instanceof SocialError || cause instanceof TradesError) &&
        RELOAD.has(cause.code)
      ) {
        reloading.current = true;
        setAttempt((n) => n + 1);
      }
    } finally {
      setBusy(false);
    }
  }
  const run: Record<Asking, () => void> = {
    decline: () => void step("decline", declineTrade),
    withdraw: () => void step("withdraw", withdrawTrade),
    cancel: () => void step("cancel", cancelTrade),
  };

  const answering =
    trade.actions.includes("accept") || trade.actions.includes("decline");
  const menu: MenuItem[] = [
    ...(trade.actions.includes("withdraw")
      ? [{ label: "Withdraw", onSelect: () => ask("withdraw") }]
      : []),
    ...(trade.actions.includes("cancel")
      ? [{ label: "Cancel Trade", onSelect: () => ask("cancel") }]
      : []),
  ];
  const answers = answering && (
    <div className="flex flex-wrap items-center gap-2">
      {trade.actions.includes("accept") && (
        <Button
          variant="primary"
          aria-disabled={busy || undefined}
          onClick={() => void step("accept", acceptTrade)}
        >
          Accept
        </Button>
      )}
      {trade.actions.includes("decline") && (
        <Button ref={declineButton} onClick={() => ask("decline")}>
          Decline
        </Button>
      )}
    </div>
  );
  return frame(
    tradeHeadline(trade),
    <>
      <p className="m-0 text-body">
        <span className="font-semibold">Trade with {name}</span>
        {trade.other.handle && (
          <span className="text-text-muted"> @{trade.other.handle}</span>
        )}
      </p>
      <div className="grid grid-cols-2 items-start gap-4 phone:grid-cols-1">
        <TradeSide title="You give" cards={trade.you_give} />
        <TradeSide title="You get" cards={trade.you_get} />
      </div>
      {asking ? (
        <div
          role="group"
          aria-label={ASK[asking].yes}
          className="flex flex-wrap items-center gap-2 rounded-panel border border-border bg-surface p-3"
        >
          <p className="m-0 min-w-0 flex-1 text-body">
            {ASK[asking].question(name)}
          </p>
          <Button
            ref={askButton}
            variant="danger"
            aria-disabled={busy || undefined}
            onClick={run[asking]}
          >
            {ASK[asking].yes}
          </Button>
          <Button
            onClick={() => {
              focusNext.current = asking === "decline" ? "decline" : "menu";
              setAsking(null);
            }}
          >
            Keep it
          </Button>
        </div>
      ) : (
        answers
      )}
      <p role="alert" className="m-0 text-meta text-danger empty:hidden">
        {message}
      </p>
    </>,
    menu.length > 0 && (
      <div ref={menuAnchor}>
        <Menu
          label="More for this Trade"
          triggerClassName="inline-flex size-control shrink-0 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent p-0 text-text-muted hover:bg-surface-raised hover:text-text phone:size-tap"
          trigger={<Icon icon={Ellipsis} />}
          items={menu}
        />
      </div>
    )
  );
}

/** One side of the Trade: each card with its copies, or "Nothing". */
function TradeSide({ title, cards }: { title: string; cards: TradeCard[] }) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-2"
    >
      <h2 id={headingId} className="m-0 text-heading font-semibold">
        {title}
      </h2>
      <ul
        aria-label={title}
        className="m-0 list-none overflow-hidden rounded-panel border border-border bg-surface p-0"
      >
        {cards.length === 0 ? (
          <li className="px-4 py-3 text-body text-text-muted">Nothing</li>
        ) : (
          cards.map((card) => (
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
              </span>
              <span className="text-body font-semibold tabular-nums">
                ×{card.copies}
              </span>
            </li>
          ))
        )}
      </ul>
    </section>
  );
}
