import { ChevronDown, ChevronUp } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import { lineEdition } from "../loans/loanText";
import { CardImage } from "../social/FriendCollectionPage";
import type {
  NearbyMatchRow,
  TradeMatchCard,
  TradeMatchRow,
  TraderMatchRow,
} from "../social_generated";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { Pill } from "../ui/Pill";
import { MessageLink } from "./MessageLink";
import { proposalPath } from "./tradeListModel";
import {
  acceptsText,
  matchHeadline,
  matchTag,
  originText,
  wantText,
} from "./tradeMatchText";
import { traderMeta, type Band } from "./traderMessages";

const LINK =
  "inline-flex h-control items-center rounded-control px-2 text-control font-medium text-accent-strong no-underline hover:bg-surface-raised phone:h-control-phone";

type Full =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; row: TradeMatchRow | TraderMatchRow };

/**
 * One match row, for a Friend (Find trades' Friends section) or a nearby collector (Near you): the header button
 * (name, the Friend's Handle, tag, Open to cash offers, the band and track record, headline) and, open, both sides,
 * then Propose trade, Message, the Trade List link and the row's menu. Show N more reads the whole row through
 * `loadAll`, and from then on the header and counts come from that read.
 */
export function MatchRow({
  row,
  handle,
  band,
  tradeListPath,
  loadAll,
  menu,
  open,
  onToggle,
  onNavigate,
}: {
  row: TradeMatchRow | NearbyMatchRow;
  /** The Friend's Handle, shown after the name; null for a collector who is not a Friend. */
  handle: string | null;
  /** The distance band, shown with the track record; null for Friends. */
  band: Band | null;
  tradeListPath: string;
  loadAll: (signal: AbortSignal) => Promise<TradeMatchRow | TraderMatchRow>;
  menu?: ReactNode;
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
  const list = tradeListPath;

  async function showAll() {
    if (full.kind === "loading") return;
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    setFull({ kind: "loading" });
    try {
      const answer = await loadAll(controller.signal);
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
      <h3 className="m-0 text-body font-normal">
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
              {handle !== null && (
                <span className="text-meta text-text-subtle wrap-anywhere">
                  @{handle}
                </span>
              )}
              {tag && <Pill tone="ok">{tag}</Pill>}
              {shown.open_to_cash_offers && <Pill>Open to cash offers</Pill>}
              {traderMeta(band, shown.completed_trades) !== null && (
                <span className="text-meta text-text-muted">
                  {traderMeta(band, shown.completed_trades)}
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
      </h3>
      {open && (
        <div
          id={panelId}
          role="region"
          aria-labelledby={buttonId}
          className="flex flex-col gap-4 border-t border-border px-4 py-4"
        >
          <div className="grid grid-cols-2 items-start gap-4 phone:grid-cols-1">
            <MatchSide
              level={4}
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
              level={4}
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
              More cards couldn't be loaded.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              aria-label={`Propose trade to ${name}`}
              onClick={() => onNavigate(proposalPath(row.trader_id))}
            >
              Propose trade
            </Button>
            <MessageLink
              traderId={row.trader_id}
              name={name}
              onNavigate={onNavigate}
            />
            <a href={list} onClick={go} className={LINK}>
              See all of {name}'s Trade List
            </a>
            {menu}
          </div>
        </div>
      )}
    </li>
  );
}

/** One side of an open row: the matched cards in card order, "Nothing" when there are none, and Show N more. */
export function MatchSide({
  level = 3,
  title,
  label,
  cards,
  more,
  busy,
  headingRef,
  onShowMore,
}: {
  /** The heading element's level: 4 under a row's h3, 2 on a page of its own. */
  level?: 2 | 3 | 4;
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
  const Heading = `h${level}` as const;
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-2"
    >
      <Heading
        ref={headingRef}
        id={headingId}
        tabIndex={-1}
        className="m-0 text-body font-semibold"
      >
        {title}
      </Heading>
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
