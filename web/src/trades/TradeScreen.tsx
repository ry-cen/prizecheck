import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, Ellipsis } from "lucide-react";
import { lineEdition } from "../loans/loanText";
import { PageHeader } from "../shell/PageHeader";
import { CardImage } from "../social/FriendCollectionPage";
import {
  getTrade,
  SocialError,
  withdrawTrade,
  type TradeCard,
  type TradeView,
} from "../social_generated";
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

/**
 * One Trade's screen (Trading #270, prototype verdict variant A), at /trades/<id>: the headline, who the Trade is
 * with, and two columns, **You give** and **You get** (one column on a phone), each card with its copies. The
 * proposer withdraws a proposal nobody has answered from **⋯**. It never names a Location or a Deck: where the
 * collector's own cards are taken from joins with Confirm swap (#272). The recipient's answers arrive with #271.
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
  // One key per step until it settles, so a step whose outcome is unknown is retried safely.
  const key = useRef<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // After a step the ⋯ menu that had focus may be gone: the heading takes it once the new Trade is drawn.
  const focusHeading = useRef(false);

  useEffect(() => {
    if (tradeId === null) return;
    const controller = new AbortController();
    getTrade(tradeId, controller.signal).then(
      (trade) => {
        if (!controller.signal.aborted) setLoad({ kind: "ready", trade });
      },
      (cause) => {
        if (controller.signal.aborted) return;
        setLoad(
          cause instanceof SocialError && cause.status === 404
            ? { kind: "missing" }
            : { kind: "failed" }
        );
      }
    );
    return () => controller.abort();
  }, [tradeId, attempt]);

  useEffect(() => {
    const element = heading.current;
    if (!focusHeading.current || load.kind !== "ready" || !element) return;
    focusHeading.current = false;
    if (!element.hasAttribute("tabindex"))
      element.setAttribute("tabindex", "-1");
    element.focus({ preventScroll: true });
  }, [load]);

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

  async function withdraw() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    key.current ??= crypto.randomUUID();
    try {
      const next = await withdrawTrade(trade.id, {
        revision: trade.revision,
        idempotency_key: key.current,
      });
      key.current = null;
      focusHeading.current = true;
      setLoad({ kind: "ready", trade: next });
      toast.show({ message: "Withdrawn" });
    } catch (cause) {
      if (!tradeOutcomeUnknown(cause)) key.current = null;
      setMessage(tradeStepMessage(cause));
      if (cause instanceof SocialError && RELOAD.has(cause.code)) {
        focusHeading.current = true;
        setAttempt((n) => n + 1);
      }
    } finally {
      setBusy(false);
    }
  }

  const menu: MenuItem[] = trade.actions.includes("withdraw")
    ? [{ label: "Withdraw", onSelect: () => void withdraw() }]
    : [];
  const name = trade.other.display_name;
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
      <p role="alert" className="m-0 text-meta text-danger empty:hidden">
        {message}
      </p>
    </>,
    menu.length > 0 && (
      <Menu
        label="More for this Trade"
        triggerClassName="inline-flex size-control shrink-0 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent p-0 text-text-muted hover:bg-surface-raised hover:text-text phone:size-tap"
        trigger={<Icon icon={Ellipsis} />}
        items={menu}
      />
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
