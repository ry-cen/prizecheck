import { useEffect, useId, useRef, useState } from "react";
import { lineEdition } from "../loans/loanText";
import type { FriendTradeCard, TraderMatchRow } from "../social_generated";
import type { TradeListCard } from "../trades_generated";
import { Button } from "../ui/Button";
import { CardArt, CardPopup } from "../ui/CardPopup";
import { EditionTile } from "../ui/EditionTile";
import { Pill } from "../ui/Pill";
import { ScrollArea } from "../ui/ScrollArea";
import { SearchField } from "../ui/SearchField";
import { Segmented } from "../ui/Segmented";
import { variantLabel } from "../ui/variantLabel";
import { useDebouncedValue } from "../workspace/useDebouncedValue";
import {
  libraryCards,
  otherSide,
  quantityIn,
  type LibraryCard,
  type Proposal,
  type ProposalSide,
} from "./proposalModel";
import { acceptsText, originText, wantText } from "./tradeMatchText";
import { tradeCardName } from "./tradeText";

export type TheirsLoad =
  | { kind: "loading" }
  | { kind: "failed" }
  | {
      kind: "ready";
      /** The search the cards were read for. */
      q: string;
      cards: FriendTradeCard[];
      nextPage: number | null;
      more: "idle" | "loading" | "failed";
    };

export type MineLoad =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; cards: TradeListCard[] };

export type MatchLoad =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; row: TraderMatchRow };

type Choice = "theirs" | "mine";

// How long the search waits after the last keystroke before it reads again, as on a Friend's Trade List.
const SEARCH_DELAY_MS = 300;

const SIDE_LABEL: Record<ProposalSide, string> = {
  get: "You get",
  give: "You give",
};

/**
 * The proposal builder's card library (Trading #284), the Deck builder's right column: a choice between **Their Trade
 * List** (cards to ask for, added to You get) and **My Trade List** (cards to give, added to You give), each with its
 * own search. The Friend's matches with the collector come first, then the rest of the list. A tile shows the copies
 * available and a flag when it matches a want ("You want" on their list, "<name> wants" on yours); one tap adds one
 * copy, and **Details** beside it opens the card without adding anything. A card on one side can't be added to the other: its tile says so and a status line
 * gives the reason. Their Trade List searches on the server and pages with **Show more cards**; My Trade List
 * filters here.
 */
export function ProposalLibrary({
  headingId,
  ownScroll,
  friendName,
  theirs,
  mine,
  match,
  onTheirSearch,
  onShowMore,
  onRetry,
  proposal,
  onAdd,
  announce,
}: {
  headingId: string;
  ownScroll: boolean;
  friendName: string;
  theirs: TheirsLoad;
  mine: MineLoad;
  match: MatchLoad;
  onTheirSearch: (q: string) => void;
  onShowMore: () => void;
  onRetry: (which: "theirs" | "mine" | "match") => void;
  proposal: Proposal;
  onAdd: (side: ProposalSide, card: LibraryCard) => void;
  announce: string;
}) {
  const [choice, setChoice] = useState<Choice>("theirs");
  const [theirText, setTheirText] = useState("");
  const [mineText, setMineText] = useState("");
  const [details, setDetails] = useState<{
    card: LibraryCard;
    side: ProposalSide;
  } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const listId = useId();
  // Whether the Friend's whole list, unsearched, was empty, so a search can't hide that.
  const [nothingListed, setNothingListed] = useState(false);

  const settled = useDebouncedValue(theirText.trim(), SEARCH_DELAY_MS);
  useEffect(() => onTheirSearch(settled), [settled]);
  useEffect(() => {
    if (theirs.kind === "ready" && theirs.q === "")
      setNothingListed(theirs.cards.length === 0);
  }, [theirs]);

  const side: ProposalSide = choice === "theirs" ? "get" : "give";
  const matches =
    match.kind === "ready"
      ? side === "get"
        ? match.row.you_get
        : match.row.you_give
      : [];
  const read = choice === "theirs" ? theirs : mine;
  const showing = read.kind === "ready" && match.kind !== "loading";
  const cards: LibraryCard[] =
    theirs.kind === "ready" && choice === "theirs"
      ? libraryCards(matches, theirs.cards, theirs.q, false)
      : mine.kind === "ready" && choice === "mine"
        ? libraryCards(matches, mine.cards, mineText, true)
        : [];
  const searching =
    choice === "theirs"
      ? theirs.kind === "ready" && theirs.q !== ""
      : mineText.trim() !== "";
  const busy =
    choice === "theirs" &&
    theirs.kind === "ready" &&
    theirText.trim() !== theirs.q;

  return (
    <aside
      aria-labelledby={headingId}
      className={`box-border flex min-w-0 flex-col self-start rounded-panel border border-border bg-surface ${
        ownScroll
          ? "sticky top-[calc(var(--space-4)+var(--layout-sticky-top))] max-h-[calc(100dvh-var(--space-8)-var(--layout-sticky-top))]"
          : "w-full"
      }`}
    >
      {/* The aside keeps the sticky position, the height cap and the frame; the ScrollArea inside scrolls. */}
      <ScrollArea
        className="flex-1"
        scroll={ownScroll}
        viewportClassName={`flex flex-col gap-3 p-4${ownScroll ? " overscroll-contain" : ""}`}
      >
        <h2 id={headingId} className="m-0 text-heading font-semibold">
          Cards
        </h2>
        <div className="shrink-0">
          <Segmented
            mode="choice"
            label="Cards from"
            options={[
              { value: "theirs", label: "Their Trade List" },
              { value: "mine", label: "My Trade List" },
            ]}
            value={choice}
            onChange={setChoice}
          />
        </div>
        {choice === "theirs" ? (
          <SearchField
            key="theirs"
            label={`Search ${friendName}'s Trade List`}
            placeholder="Card name"
            maxLength={100}
            value={theirText}
            onChange={(event) => setTheirText(event.target.value)}
          />
        ) : (
          <SearchField
            key="mine"
            label="Search your Trade List"
            placeholder="Card name"
            maxLength={100}
            value={mineText}
            onChange={(event) => setMineText(event.target.value)}
          />
        )}
        <p role="status" className="m-0 min-h-5 text-meta text-text-muted">
          {announce}
        </p>
        {match.kind === "failed" && (
          <div className="flex flex-wrap items-center gap-3">
            <p role="alert" className="m-0 text-meta text-danger">
              Matches with {friendName} couldn't be loaded.
            </p>
            <Button onClick={() => onRetry("match")}>Retry matches</Button>
          </div>
        )}
        {read.kind === "failed" && (
          <div className="flex flex-wrap items-center gap-3">
            <p role="alert" className="m-0 text-meta text-danger">
              These cards couldn't be loaded.
            </p>
            <Button onClick={() => onRetry(choice)}>Retry</Button>
          </div>
        )}
        {(read.kind === "loading" ||
          (read.kind === "ready" && match.kind === "loading")) && (
          <p className="m-0 text-body text-text-muted">Loading cards…</p>
        )}
        {showing && cards.length === 0 && (
          <p className="m-0 text-body text-text-muted">
            {searching && (choice === "mine" || !nothingListed)
              ? "No cards match that name."
              : choice === "theirs"
                ? `${friendName} has nothing on their Trade List.`
                : "Your Trade List is empty. Mark a Location For trade in Collection, and its cards show here."}
          </p>
        )}
        {showing && cards.length > 0 && (
          <ul
            id={listId}
            aria-label={
              choice === "theirs"
                ? `${friendName}'s Trade List`
                : "Your Trade List"
            }
            aria-busy={busy}
            className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(var(--tile-small),1fr))] gap-x-(--tile-gap-column) gap-y-(--tile-gap-row) p-0"
          >
            {cards.map((libraryCard) => {
              const { card, want } = libraryCard;
              const held = quantityIn(proposal, side, card.edition_id);
              const onOther =
                quantityIn(proposal, otherSide(side), card.edition_id) > 0;
              const copies = Number(card.copies);
              return (
                <li
                  key={card.edition_id}
                  className="flex min-w-0 flex-col gap-1"
                >
                  <EditionTile
                    action={`Add to ${SIDE_LABEL[side]}`}
                    name={card.name}
                    setName={card.set_name}
                    setCode={card.set_code}
                    collectorNumber={card.collector_number}
                    variant={variantLabel(card.descriptor)}
                    imageUrl={card.image_url}
                    owned={onOther ? 0 : copies}
                    badge={held > 0 ? `${held}/${copies}` : undefined}
                    ownedText={
                      onOther
                        ? `in ${SIDE_LABEL[otherSide(side)]}`
                        : held > 0
                          ? `${held} of ${copies} in ${SIDE_LABEL[side]}`
                          : `${copies} available`
                    }
                    flag={
                      want
                        ? {
                            text:
                              side === "get"
                                ? "You want"
                                : `${friendName} wants`,
                            label: wantText(want),
                          }
                        : null
                    }
                    aria-disabled={onOther || held >= copies || undefined}
                    onClick={() => onAdd(side, libraryCard)}
                  />
                  <Button
                    variant="quiet"
                    aria-label={`Details for ${tradeCardName(card)}`}
                    onClick={(event) => {
                      opener.current = event.currentTarget;
                      setDetails({ card: libraryCard, side });
                    }}
                  >
                    Details
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        {choice === "theirs" &&
          theirs.kind === "ready" &&
          theirs.nextPage !== null && (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                aria-controls={listId}
                aria-disabled={theirs.more === "loading" || undefined}
                onClick={onShowMore}
              >
                Show more cards
              </Button>
              {theirs.more === "failed" && (
                <p role="alert" className="m-0 text-meta text-danger">
                  More cards couldn't be loaded. Please retry.
                </p>
              )}
            </div>
          )}
        <DetailsPopup
          details={details}
          proposal={proposal}
          opener={opener}
          onClose={() => setDetails(null)}
        />
      </ScrollArea>
    </aside>
  );
}

/** A library card's popup: the artwork, its Edition, the copies available, how many are on the proposal and, for a
 * matched card, what it matches. It adds nothing. */
function DetailsPopup({
  details,
  proposal,
  opener,
  onClose,
}: {
  details: { card: LibraryCard; side: ProposalSide } | null;
  proposal: Proposal;
  opener: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  // Kept while it closes, so the dialog doesn't lose its content mid-close.
  const last = useRef(details);
  if (details) last.current = details;
  const shown = details ?? last.current;
  const card = shown?.card.card ?? null;
  const want = shown?.card.want ?? null;
  const held =
    shown && card ? quantityIn(proposal, shown.side, card.edition_id) : 0;
  const accepts = want ? acceptsText(want) : null;
  return (
    <CardPopup
      open={details !== null}
      onClose={onClose}
      title={card?.name ?? ""}
      position={null}
      canPrevious={false}
      canNext={false}
      onPrevious={() => {}}
      onNext={() => {}}
      cardKey={card?.edition_id ?? ""}
      returnFocus={opener}
      art={card && <CardArt url={card.image_url} name={card.name} />}
    >
      {card && shown && (
        <>
          <div className="flex flex-col gap-1">
            <span className="text-body tabular-nums">{lineEdition(card)}</span>
            <span className="text-meta text-text-muted">{card.set_name}</span>
          </div>
          <div className="flex flex-col gap-1 text-body">
            <span>{card.copies} available</span>
            {held > 0 && (
              <span>
                {held} in {SIDE_LABEL[shown.side]}
              </span>
            )}
          </div>
          {want && (
            <div className="flex flex-wrap gap-1">
              <Pill>{wantText(want)}</Pill>
              <Pill>{originText(want)}</Pill>
              {accepts && <Pill tone="ok">{accepts}</Pill>}
            </div>
          )}
        </>
      )}
    </CardPopup>
  );
}
