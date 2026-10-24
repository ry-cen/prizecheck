import { ChevronDown, ChevronUp } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
  type Ref,
} from "react";
import { lineEdition } from "../loans/loanText";
import { CardImage } from "../social/FriendCollectionPage";
import { useOpenFriends } from "../social/FriendsDrawer";
import {
  getTradeMatch,
  getTradeMatches,
  type TradeMatchCard,
  type TradeMatches,
  type TradeMatchRow,
} from "../social_generated";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { Pill } from "../ui/Pill";
import { trackRecord } from "./conversationMessages";
import { friendTradeListPath, proposalPath } from "./tradeListModel";
import {
  acceptsText,
  matchHeadline,
  matchTag,
  originText,
  wantText,
} from "./tradeMatchText";

type Load =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; matches: TradeMatches };

const LINK =
  "inline-flex h-control items-center rounded-control px-2 text-control font-medium text-accent-strong no-underline hover:bg-surface-raised phone:h-control-phone";

/**
 * Find trades (Trading #276, prototype verdict variant A), at /trades/find: one row per Friend who matches, two-way
 * matches first, then Friends who have cards the collector wants, then Friends who want cards the collector has. A row
 * is a button that opens both sides, showing only the matched cards: **You get** (each marked Exact, Any finish or
 * Same name) and **You give**, each with the copies offered and how many are wanted ("6 wanted (2 for Decks)") and
 * whether the want is for Decks, for Trade Wants or both. A side past 20 cards has **Show N more**, which reads that
 * Friend's whole row, moves focus to that side's heading when it arrives, and from then on the row's header and
 * counts come from that read. **Propose trade** opens the proposal builder to that Friend empty (Trading #284), where
 * the matched cards are listed first. Nothing shows a price, a Location or a Deck. It reads again each time it
 * opens.
 */
export function FindTrades({
  onNavigate,
}: {
  onNavigate: (to: string) => void;
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ kind: "loading" });
    getTradeMatches(controller.signal)
      .then((matches) => {
        if (!controller.signal.aborted) setLoad({ kind: "ready", matches });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoad({ kind: "failed" });
      });
    return () => controller.abort();
  }, [attempt]);

  if (load.kind === "loading")
    return (
      <p role="status" className="m-0 text-body text-text-muted">
        Loading matches…
      </p>
    );
  if (load.kind === "failed")
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p role="status" className="m-0 text-body text-text-muted">
          Matches couldn't be loaded.
        </p>
        <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
      </div>
    );
  const { matches } = load;
  if (!matches.has_friends) return <NeedsFriends />;
  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <>
      <p className="m-0 text-body text-text-muted">
        Friends who have cards you want, or want cards you have.
      </p>
      {matches.rows.length === 0 ? (
        <p role="status" className="m-0 text-body text-text-muted">
          None of your Friends has cards you want or wants yours yet.
        </p>
      ) : (
        <ul
          aria-label="Matches"
          className="m-0 flex list-none flex-col gap-3 p-0"
        >
          {matches.rows.map((row) => (
            <MatchRow
              key={row.collector_id}
              row={row}
              open={open.has(row.collector_id)}
              onToggle={() => toggle(row.collector_id)}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      )}
    </>
  );
}

/** The empty state for a collector with no Friends (story 51): matching needs Friends, and Add a Friend opens the
 * Friends drawer. */
function NeedsFriends() {
  const headingId = useId();
  const openFriends = useOpenFriends();
  const add = useRef<HTMLButtonElement>(null);
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col items-start gap-3 rounded-panel border border-border bg-surface px-6 py-6 phone:px-4 phone:py-4"
    >
      <h2 id={headingId} className="m-0 text-heading font-semibold">
        Matching needs Friends
      </h2>
      <p className="m-0 text-body text-text-muted">
        Trading matches you with your Friends. Add a Friend to see who has cards
        you want.
      </p>
      {openFriends && (
        <Button ref={add} variant="primary" onClick={() => openFriends(add)}>
          Add a Friend
        </Button>
      )}
    </section>
  );
}

type Full =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; row: TradeMatchRow };

/** One Friend's row: the header button (name, Handle, tag, Open to cash offers, headline) and, open, both sides. */
function MatchRow({
  row,
  open,
  onToggle,
  onNavigate,
}: {
  row: TradeMatchRow;
  open: boolean;
  onToggle: () => void;
  onNavigate: (to: string) => void;
}) {
  const buttonId = useId();
  const panelId = useId();
  const [full, setFull] = useState<Full>({ kind: "idle" });
  const reading = useRef<AbortController | null>(null);
  useEffect(() => () => reading.current?.abort(), []);

  const name = row.display_name;
  const shown = full.kind === "ready" ? full.row : row;
  const tag = matchTag(shown);
  const getHeading = useRef<HTMLHeadingElement>(null);
  const giveHeading = useRef<HTMLHeadingElement>(null);
  // The side whose Show N more was pressed: its button leaves with the load, so focus goes to its heading.
  const asked = useRef<"get" | "give" | null>(null);
  useEffect(() => {
    if (full.kind === "ready" && asked.current)
      (asked.current === "get" ? getHeading : giveHeading).current?.focus();
    if (full.kind === "ready" || full.kind === "failed") asked.current = null;
  }, [full]);
  const list = friendTradeListPath(row.handle);

  async function showAll() {
    if (full.kind === "loading") return;
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    setFull({ kind: "loading" });
    try {
      const answer = await getTradeMatch(row.collector_id, controller.signal);
      if (!controller.signal.aborted) setFull({ kind: "ready", row: answer });
    } catch {
      if (!controller.signal.aborted) setFull({ kind: "failed" });
    }
  }

  const go = (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    onNavigate(list);
  };

  return (
    <li className="overflow-hidden rounded-panel border border-border bg-surface">
      <h2 className="m-0 text-body font-normal">
        <button
          id={buttonId}
          type="button"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={onToggle}
          className="box-border flex min-h-tap w-full cursor-pointer items-start gap-3 border-0 bg-transparent px-4 py-3 text-left font-sans text-text hover:bg-surface-raised"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-body font-semibold wrap-anywhere">
                {name}
              </span>
              <span className="text-meta text-text-subtle wrap-anywhere">
                @{row.handle}
              </span>
              {tag && <Pill tone="ok">{tag}</Pill>}
              {shown.open_to_cash_offers && <Pill>Open to cash offers</Pill>}
              {trackRecord(shown.completed_trades) !== null && (
                <span className="text-meta text-text-muted">
                  {trackRecord(shown.completed_trades)}
                </span>
              )}
            </span>
            <span className="text-meta text-text-muted">
              {matchHeadline(shown)}
            </span>
          </span>
          <Icon
            icon={open ? ChevronUp : ChevronDown}
            size={20}
            className="mt-0.5 shrink-0 text-text-muted"
          />
        </button>
      </h2>
      {open && (
        <div
          id={panelId}
          role="region"
          aria-labelledby={buttonId}
          className="flex flex-col gap-4 border-t border-border px-4 py-4"
        >
          <div className="grid grid-cols-2 items-start gap-4 phone:grid-cols-1">
            <MatchSide
              title="You get"
              label={`You get from ${name}`}
              cards={shown.you_get}
              more={shown.more_you_get}
              busy={full.kind === "loading"}
              headingRef={getHeading}
              onShowMore={() => {
                asked.current = "get";
                void showAll();
              }}
            />
            <MatchSide
              title="You give"
              label={`You give ${name}`}
              cards={shown.you_give}
              more={shown.more_you_give}
              busy={full.kind === "loading"}
              headingRef={giveHeading}
              onShowMore={() => {
                asked.current = "give";
                void showAll();
              }}
            />
          </div>
          {full.kind === "failed" && (
            <p role="alert" className="m-0 text-meta text-danger">
              More cards couldn't be loaded. Please retry.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              aria-label={`Propose trade to ${name}`}
              onClick={() => onNavigate(proposalPath(row.handle))}
            >
              Propose trade
            </Button>
            <a href={list} onClick={go} className={LINK}>
              See all of {name}'s Trade List
            </a>
          </div>
        </div>
      )}
    </li>
  );
}

/** One side of an open row: the matched cards in card order, "Nothing" when there are none, and Show N more. */
function MatchSide({
  title,
  label,
  cards,
  more,
  busy,
  headingRef,
  onShowMore,
}: {
  title: string;
  label: string;
  cards: TradeMatchCard[];
  more: number;
  busy: boolean;
  headingRef: Ref<HTMLHeadingElement>;
  onShowMore: () => void;
}) {
  const headingId = useId();
  const listId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-2"
    >
      <h3
        ref={headingRef}
        id={headingId}
        tabIndex={-1}
        className="m-0 text-body font-semibold"
      >
        {title}
      </h3>
      <ul
        id={listId}
        aria-label={label}
        className="m-0 list-none overflow-hidden rounded-panel border border-border bg-surface p-0"
      >
        {cards.length === 0 ? (
          <li className="px-3 py-3 text-body text-text-muted">Nothing</li>
        ) : (
          cards.map((card) => <MatchCard key={card.edition_id} card={card} />)
        )}
      </ul>
      {more > 0 && (
        <div>
          <Button
            aria-controls={listId}
            aria-disabled={busy || undefined}
            onClick={onShowMore}
          >
            Show {more} more
          </Button>
        </div>
      )}
    </section>
  );
}

function MatchCard({ card }: { card: TradeMatchCard }) {
  const accepts = acceptsText(card);
  return (
    <li className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-3 py-3 last:border-b-0">
      <CardImage url={card.image_url} />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-body font-semibold wrap-anywhere">
          {card.name}
        </span>
        <span className="text-meta text-text-muted tabular-nums wrap-anywhere">
          {lineEdition(card)}
        </span>
        <span className="text-meta text-text-muted tabular-nums">
          {wantText(card)}
        </span>
        <span className="flex flex-wrap gap-1">
          <Pill>{originText(card)}</Pill>
          {accepts && <Pill tone="ok">{accepts}</Pill>}
        </span>
      </span>
      <span className="text-body font-semibold tabular-nums">
        ×{card.copies}
      </span>
    </li>
  );
}
