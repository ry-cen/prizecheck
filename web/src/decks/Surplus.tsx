import { useId, useMemo } from "react";
import { TriangleAlert } from "lucide-react";
import type { CompetitionWarning, SurplusHolding } from "../decks_generated";
import { Button } from "../ui/Button";
import { CopyArt, CopyTile } from "../ui/CopyTile";
import { Icon } from "../ui/Icon";
import type { DeckLine, DeckView } from "./deckListModel";
import {
  competingDeckText,
  competitionNotes,
  competitionSummary,
  SURPLUS_SPREAD_LIMIT,
  surplusCards,
  surplusCopyLabel,
  surplusPileLabel,
  surplusTotal,
  type SurplusCard,
} from "./surplusModel";

/** Opens Put away for these cards' surplus copies: every surplus card, or the one that was pressed. */
export type OpenPutAway = (editionIds: readonly string[] | "all") => void;

/**
 * The surplus group (#180): copies physically in the Deck but cut from its Deck List, under the Deck List in every
 * view. **Put away all** opens one Move of every surplus copy to a Location the collector picks; pressing a card's
 * tile, pile or row opens it for that card's surplus copies only. Surplus never counts toward N/60. Nothing renders
 * when the Deck holds no surplus.
 */
export function SurplusGroup({
  rows,
  view,
  onPutAway,
}: {
  rows: readonly SurplusHolding[];
  view: DeckView;
  onPutAway: OpenPutAway;
}) {
  const headingId = useId();
  const cards = useMemo(() => surplusCards(rows), [rows]);
  if (!cards.length) return null;
  const total = surplusTotal(cards);
  const one = (card: SurplusCard) => () => onPutAway([card.editionId]);
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 border-t border-border pt-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3
          id={headingId}
          aria-label={`Surplus, ${total.toString()} ${total === 1n ? "card" : "cards"}`}
          className="m-0 flex items-baseline gap-2 text-meta font-semibold text-text-muted"
        >
          Surplus
          <span className="tabular-nums text-text-subtle">
            <span className="sr-only">, </span>
            {total.toString()}
            <span className="sr-only">{total === 1n ? " card" : " cards"}</span>
          </span>
        </h3>
        <Button onClick={() => onPutAway("all")}>Put away all</Button>
      </div>
      <p className="m-0 text-caption text-text-subtle">
        In this Deck but not on its Deck List. Press a card to put away just
        that one.
      </p>
      {view === "list" ? (
        <ul className="m-0 list-none p-0">
          {cards.map((card) => (
            <li
              key={card.editionId}
              className="grid grid-cols-[2rem_minmax(0,1fr)] items-center gap-2 border-b border-border py-0.5"
            >
              <span className="text-right text-control font-semibold tabular-nums">
                <span className="sr-only">Quantity </span>
                {card.quantity.toString()}
              </span>
              <button
                type="button"
                aria-label={surplusPileLabel(card)}
                title={surplusPileLabel(card)}
                onClick={one(card)}
                className="m-0 box-border flex min-h-control min-w-0 cursor-pointer flex-col justify-center rounded-control border-0 bg-transparent px-1 text-left font-sans text-text hover:bg-surface-raised phone:min-h-tap"
              >
                <span className="block truncate text-control font-medium">
                  {card.name}
                </span>
                <span className="block truncate text-caption text-text-subtle">
                  {card.edition}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="m-0 flex list-none flex-wrap items-start gap-x-4 gap-y-3 p-0">
          {cards.map((card) => (
            <li key={card.editionId} className="flex flex-wrap gap-1">
              {view === "spread" && card.quantity <= SURPLUS_SPREAD_LIMIT ? (
                Array.from({ length: Number(card.quantity) }, (_, index) => (
                  <CopyTile
                    key={index}
                    className="w-14 phone:w-12"
                    label={surplusCopyLabel(card, index + 1)}
                    title={surplusCopyLabel(card, index + 1)}
                    name={card.name}
                    setName=""
                    collectorNumber=""
                    variant=""
                    imageUrl={card.imageUrl}
                    names={false}
                    onClick={one(card)}
                  />
                ))
              ) : (
                <SurplusPile card={card} onPress={one(card)} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One pile per surplus Edition, as the Deck List's Stacked view draws a line: one button, so a phone's 44 px tap
 * area is the whole pile. */
function SurplusPile({
  card,
  onPress,
}: {
  card: SurplusCard;
  onPress: () => void;
}) {
  const label = surplusPileLabel(card);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onPress}
      className="m-0 box-border flex w-16 cursor-pointer flex-col gap-1 rounded-card border-0 bg-transparent p-0 text-left font-sans text-text phone:w-14"
    >
      <span aria-hidden="true" className="relative block pb-2 pr-2">
        {card.quantity > 2n && (
          <span className="absolute bottom-0 left-2 right-0 top-2 rounded-card border border-border-strong bg-surface-raised" />
        )}
        {card.quantity > 1n && (
          <span className="absolute bottom-1 left-1 right-1 top-1 rounded-card border border-border-strong bg-surface-raised" />
        )}
        <CopyArt name={card.name} imageUrl={card.imageUrl} />
      </span>
      <span
        aria-hidden="true"
        className="block whitespace-nowrap text-caption font-semibold tabular-nums"
      >
        ×{card.quantity.toString()}
      </span>
    </button>
  );
}

/**
 * The competition warning (#180): a line of this Deck whose owned-elsewhere copies other Decks' Deck Lists count too,
 * so the spare copies can't cover every Deck at once. Names each card and each other Deck, and says whether that Deck
 * also counts the copies or holds them for its own list. Nothing is reserved, so this only warns. Nothing renders
 * without a warning.
 */
export function CompetitionNotice({
  warnings,
  lines,
}: {
  warnings: readonly CompetitionWarning[];
  lines: readonly DeckLine[];
}) {
  const titleId = useId();
  const notes = useMemo(
    () => competitionNotes(warnings, lines),
    [warnings, lines]
  );
  if (!notes.length) return null;
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className="box-border flex flex-col gap-2 rounded-panel border border-warning bg-surface p-3 text-body"
    >
      <p
        id={titleId}
        className="m-0 flex items-center gap-2 font-semibold text-warning"
      >
        <Icon icon={TriangleAlert} size={16} className="shrink-0" />
        Other Decks count the same spare copies
      </p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {notes.map((note) => (
          <li key={note.editionId} className="flex flex-col gap-0.5">
            <p className="m-0 wrap-anywhere">
              <strong className="font-semibold">{note.name}</strong>
              {note.edition && (
                <span className="text-text-muted"> · {note.edition}</span>
              )}
              : {competitionSummary(note)}
            </p>
            <ul className="m-0 list-disc pl-5 text-meta text-text-muted">
              {note.decks.map((deck) => (
                <li key={deck.deckId} className="wrap-anywhere">
                  {competingDeckText(deck)}.
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
