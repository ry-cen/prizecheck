import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronLeft, Ellipsis, TriangleAlert } from "lucide-react";
import { getLocationTree, type TreeLocation } from "../location_generated";
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
import {
  acceptTrade,
  confirmSwap,
  getTradeSide,
  TradesError,
  useSuggestedTradePicks,
  type OwnTradeSide,
} from "../trades_generated";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../ui/Icon";
import { Menu, type MenuItem } from "../ui/Menu";
import { Select } from "../ui/Select";
import { useToast } from "../ui/Toast";
import { indexLocations } from "../workspace/locationTree";
import { TRADES_PATH } from "./tradeListModel";
import {
  swapDoneMessage,
  tradeCardName,
  tradeHeadline,
  tradeNote,
  tradeOutcomeUnknown,
  tradePickText,
  tradeStaleText,
  tradeStepMessage,
} from "./tradeText";

type Load =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "failed" }
  | { kind: "ready"; trade: TradeView; side: OwnTradeSide };

/** The refusals that mean the Trade or the reader's picks moved on: the screen reads both again. */
const RELOAD = new Set([
  "TRADE_CHANGED",
  "STEP_NOT_ALLOWED",
  "PICKS_OUT_OF_DATE",
  "PICKS_UP_TO_DATE",
]);

/** A step the screen runs; its idempotency key is kept under this name until it settles. */
type StepName = Asking | "accept" | "use_suggested" | "confirm";

/** A place the confirm dialog offers for the cards the reader gets: one of their Storage Leaves or Decks, by full
 * path, a Deck marked " (Deck)". */
type SwapPlace = { id: string; path: string; label: string };

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

/** What each step's toast says once it went through. Confirm swap's names where the cards went (swapDoneMessage). */
const DONE: Record<Asking | "accept" | "use_suggested", string> = {
  accept: "Accepted. Swap the cards in person, then confirm.",
  use_suggested: "Picks updated",
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
 * show.
 *
 * Confirm swap (#272): an accepted Trade has one primary button, **Confirm swap**, or **Use suggested picks** first
 * while one of the reader's picks is out of date (a proposer gets it on a waiting proposal too). Confirm swap opens a
 * dialog with what they give and where from, what they get, where to put it (Unsorted by default; no picker when they
 * get nothing) and "The swap can't be undone." The cards the reader gives show where their picks take them from, and
 * an out-of-date pick says what the suggestion takes instead. Those are the reader's own Locations, from their own side
 * read (`GET /api/trades/{id}/side`); the other side's never reach this screen.
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
  // The Confirm swap dialog: open or not, where the cards the reader gets go ("" for Unsorted), and its own message.
  const [confirming, setConfirming] = useState(false);
  const [destination, setDestination] = useState("");
  const [dialogMessage, setDialogMessage] = useState("");
  const places = useSwapPlaces(confirming);
  // One key per step until it settles, so a step whose outcome is unknown is retried safely.
  const keys = useRef(new Map<string, string>());
  const heading = useRef<HTMLHeadingElement>(null);
  const menuAnchor = useRef<HTMLDivElement>(null);
  const askButton = useRef<HTMLButtonElement>(null);
  const declineButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<FocusNext | null>(null);
  // A step refused because the Trade moved on reads it again: an open question closes and the heading takes focus
  // once the new Trade is drawn, so focus never lands on the old headline.
  const reloading = useRef(false);

  useEffect(() => {
    if (tradeId === null) return;
    const controller = new AbortController();
    Promise.all([
      getTrade(tradeId, controller.signal),
      getTradeSide(tradeId, controller.signal),
    ]).then(
      ([trade, side]) => {
        if (controller.signal.aborted) return;
        if (reloading.current) {
          reloading.current = false;
          focusNext.current = "heading";
          setAsking(null);
          setConfirming(false);
        }
        setLoad({ kind: "ready", trade, side });
      },
      (cause) => {
        if (controller.signal.aborted) return;
        reloading.current = false;
        setLoad(
          (cause instanceof SocialError || cause instanceof TradesError) &&
            cause.status === 404
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
  const frame = (
    title: string,
    children: ReactNode,
    actions?: ReactNode,
    dialog?: ReactNode
  ) => (
    <main className="mx-auto box-border flex max-w-5xl flex-col gap-4 px-7 py-6 phone:px-4 phone:py-4">
      {back}
      <PageHeader title={title} actions={actions} headingRef={heading} />
      {children}
      {dialog}
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

  const { trade, side } = load;
  const name = trade.other.display_name;
  const stale = side.picks.some((place) => place.short !== "0");
  const gets = trade.you_get.length > 0;

  /** Asks before a step that ends the Trade, with focus on the confirmation's button. */
  function ask(step: Asking) {
    if (busy) return;
    setMessage("");
    focusNext.current = "ask";
    setAsking(step);
  }
  /**
   * Runs one step: the answer replaces the Trade, the reader's own side is read again, the question or dialog closes
   * and the heading takes focus. A refusal that means the Trade or the picks moved on reads both again; Confirm swap's
   * refusals about where the cards go stay in its dialog, so the collector can choose another place.
   */
  async function step(
    action: StepName,
    call: (body: TradeStep) => Promise<TradeView>,
    done: (next: TradeView) => string
  ) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    setDialogMessage("");
    const key = keys.current.get(action) ?? crypto.randomUUID();
    keys.current.set(action, key);
    try {
      const next = await call({
        revision: trade.revision,
        idempotency_key: key,
      });
      keys.current.delete(action);
      const nextSide = await getTradeSide(trade.id).catch(() => side);
      focusNext.current = "heading";
      setAsking(null);
      setConfirming(false);
      setLoad({ kind: "ready", trade: next, side: nextSide });
      toast.show({ message: done(next) });
    } catch (cause) {
      if (!tradeOutcomeUnknown(cause)) keys.current.delete(action);
      const code =
        cause instanceof SocialError || cause instanceof TradesError
          ? cause.code
          : null;
      const text = tradeStepMessage(cause, trade);
      if (code !== null && RELOAD.has(code)) {
        setMessage(text);
        reloading.current = true;
        setAttempt((n) => n + 1);
      } else if (action === "confirm") {
        setDialogMessage(text);
        if (code === "LOCATION_NOT_FOUND") {
          setDestination("");
          places.reload();
        }
      } else setMessage(text);
    } finally {
      setBusy(false);
    }
  }
  const run: Record<Asking, () => void> = {
    decline: () =>
      void step(
        "decline",
        (body) => declineTrade(trade.id, body),
        () => DONE.decline
      ),
    withdraw: () =>
      void step(
        "withdraw",
        (body) => withdrawTrade(trade.id, body),
        () => DONE.withdraw
      ),
    cancel: () =>
      void step(
        "cancel",
        (body) => cancelTrade(trade.id, body),
        () => DONE.cancel
      ),
  };
  const chosen = places.list.find((place) => place.id === destination);
  function openConfirm() {
    if (busy) return;
    setMessage("");
    setDialogMessage("");
    setConfirming(true);
  }
  function runConfirm() {
    void step(
      "confirm",
      (body) =>
        confirmSwap(trade.id, {
          ...body,
          destination_id: gets && destination !== "" ? destination : null,
        }),
      () => swapDoneMessage(trade, gets ? (chosen?.path ?? "Unsorted") : null)
    );
  }

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
  const fixing = stale && trade.actions.includes("use_suggested_picks");
  const answers = answering ? (
    <div className="flex flex-wrap items-center gap-2">
      {trade.actions.includes("accept") && (
        <Button
          variant="primary"
          aria-disabled={busy || undefined}
          onClick={() =>
            void step(
              "accept",
              (body) => acceptTrade(trade.id, body),
              () => DONE.accept
            )
          }
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
  ) : fixing ? (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="primary"
        aria-disabled={busy || undefined}
        onClick={() =>
          void step(
            "use_suggested",
            (body) => useSuggestedTradePicks(trade.id, body),
            () => DONE.use_suggested
          )
        }
      >
        Use suggested picks
      </Button>
    </div>
  ) : trade.actions.includes("confirm_swap") ? (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        ref={confirmButton}
        variant="primary"
        aria-disabled={busy || undefined}
        onClick={openConfirm}
      >
        Confirm swap
      </Button>
    </div>
  ) : null;
  const note = tradeNote(trade, stale);
  return frame(
    tradeHeadline(trade),
    <>
      <p className="m-0 text-body">
        <span className="font-semibold">Trade with {name}</span>
        {trade.other.handle && (
          <span className="text-text-muted"> @{trade.other.handle}</span>
        )}
      </p>
      {note && <p className="m-0 text-body text-text-muted">{note}</p>}
      <div className="grid grid-cols-2 items-start gap-4 phone:grid-cols-1">
        <TradeSide title="You give" cards={trade.you_give} side={side} />
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
    ),
    <Dialog
      open={confirming}
      onClose={() => {
        // Back and Escape wait for the request, so a failure message always lands in an open dialog.
        if (!busy) setConfirming(false);
      }}
      title={`Confirm swap with ${name}?`}
      returnFocus={confirmButton}
    >
      <div className="flex flex-col gap-4">
        {trade.you_give.length > 0 && (
          <SwapLines
            title="You give"
            lines={trade.you_give.map((card) => {
              const from = tradePickText(side.picks, card.edition_id, true);
              return {
                key: card.edition_id,
                text: `${tradeCardName(card)} ×${card.copies}${from ? ` · ${from}` : ""}`,
              };
            })}
          />
        )}
        {gets && (
          <SwapLines
            title="You get"
            lines={trade.you_get.map((card) => ({
              key: card.edition_id,
              text: `${tradeCardName(card)} ×${card.copies}`,
            }))}
          />
        )}
        {gets && (
          <div className="flex flex-col gap-1">
            <Select
              label="Put the cards you get in"
              value={destination}
              // After a confirm whose outcome is unknown the held key belongs to this destination: keep it until known.
              disabled={busy || keys.current.has("confirm")}
              onChange={(event) => {
                // Another place is another command: a retry with the old key would be refused.
                keys.current.delete("confirm");
                setDialogMessage("");
                setDestination(event.target.value);
              }}
            >
              <option value="">Unsorted</option>
              {places.list.map((place) => (
                <option key={place.id} value={place.id}>
                  {place.label}
                </option>
              ))}
            </Select>
            {places.state === "failed" && (
              <div className="flex flex-wrap items-center gap-2">
                <p className="m-0 text-meta text-text-muted">
                  Your other places couldn't be loaded.
                </p>
                <Button onClick={places.reload}>Retry</Button>
              </div>
            )}
          </div>
        )}
        <p className="m-0 text-meta text-text-muted">
          The swap can't be undone.
        </p>
        <p role="alert" className="m-0 text-meta text-danger empty:hidden">
          {dialogMessage}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) setConfirming(false);
            }}
          >
            Back
          </Button>
          <Button
            variant="primary"
            aria-disabled={busy || undefined}
            onClick={runConfirm}
          >
            Confirm swap
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * The places the confirm dialog offers for the cards the reader gets, read from their Location tree each time the
 * dialog opens: every Storage Leaf and Deck with nothing inside, in tree order, by full path, a Deck marked " (Deck)".
 * The top-level Unsorted is left out: the dialog offers it first as "Unsorted", sent as no destination, so the swap
 * makes it when it is missing.
 */
function useSwapPlaces(open: boolean): {
  state: "loading" | "ready" | "failed";
  list: SwapPlace[];
  reload: () => void;
} {
  const [nodes, setNodes] = useState<TreeLocation[] | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setState("loading");
    getLocationTree()
      .then((tree) => {
        if (!live) return;
        setNodes(tree.locations);
        setState("ready");
      })
      .catch(() => {
        if (live) setState("failed");
      });
    return () => {
      live = false;
    };
  }, [open, generation]);
  const list = useMemo(() => {
    const index = indexLocations(nodes ?? []);
    const found: SwapPlace[] = [];
    const walk = (parent: string | null) => {
      for (const node of index.children(parent)) {
        if (node.kind === "organization") walk(node.id);
        else if (index.children(node.id).length > 0) continue;
        else if (
          parent === null &&
          node.kind === "storage_leaf" &&
          node.name.trim().toLowerCase() === "unsorted"
        )
          continue;
        else {
          const path = index.path(node.id);
          found.push({
            id: node.id,
            path,
            label: node.kind === "deck" ? `${path} (Deck)` : path,
          });
        }
      }
    };
    walk(null);
    return found;
  }, [nodes]);
  return {
    state,
    list,
    reload: () => setGeneration((value) => value + 1),
  };
}

/** One side of the confirm dialog: "You give", then each card with its copies (and where it comes from). */
function SwapLines({
  title,
  lines,
}: {
  title: string;
  lines: { key: string; text: string }[];
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1">
      <h3 id={headingId} className="m-0 text-meta text-text-muted">
        {title}
      </h3>
      <ul aria-label={title} className="m-0 flex list-none flex-col gap-1 p-0">
        {lines.map((line) => (
          <li key={line.key} className="text-body wrap-anywhere">
            {line.text}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One side of the Trade: each card with its copies, or "Nothing". With `side` (You give): where the reader's picks
 * take each card from, and any out-of-date pick with what the suggestion takes instead. */
function TradeSide({
  title,
  cards,
  side,
}: {
  title: string;
  cards: TradeCard[];
  side?: OwnTradeSide;
}) {
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
                {side && <PickLines side={side} editionId={card.edition_id} />}
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

/** Under a card the reader gives: "From Binder 1", or each out-of-date pick with what to take instead. */
function PickLines({
  side,
  editionId,
}: {
  side: OwnTradeSide;
  editionId: string;
}) {
  const stale = tradeStaleText(side.picks, side.suggested, editionId);
  if (stale.length > 0)
    return stale.map(({ key, text }) => (
      <span
        key={key}
        className="inline-flex items-start gap-1 text-meta text-warning wrap-anywhere"
      >
        <Icon icon={TriangleAlert} size={14} className="mt-0.5 shrink-0" />
        {text}
      </span>
    ));
  const from = tradePickText(side.picks, editionId);
  return from ? (
    <span className="text-meta text-text-muted wrap-anywhere">{from}</span>
  ) : null;
}
