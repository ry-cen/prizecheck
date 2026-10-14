import { useId, type MouseEvent } from "react";
import {
  editionText,
  type DeckLine,
  type DeckView,
  type LineGroup,
} from "../decks/deckListModel";
import { CopyArt, CopyTile } from "../ui/CopyTile";
import {
  cardPrice,
  linePrice,
  pileLabel,
  tileLabel,
  type Prices,
} from "./publishedDeckModel";

/** Opens the read-only card popup on a line; `opener` is the control pressed, for focus return. */
export type OpenCard = (line: DeckLine, opener: HTMLElement) => void;

type Props = {
  view: DeckView;
  groups: readonly LineGroup[];
  /** Per-copy prices by line key, or null while the cost is pending. */
  prices: Prices;
  /** Line keys a card-level issue of the Target Format's result names: outlined and marked "!". */
  flagged: ReadonlySet<string>;
  /** The Target Format's name, for the flagged controls' description. */
  formatName: string;
  onOpen: OpenCard;
};

/** The "!" on a line with a card-level format issue: the mark, not the colour, says it. */
function IssueMark() {
  return (
    <span
      aria-hidden="true"
      className="absolute -left-1.5 -top-1.5 z-1 box-border flex h-4 w-4 items-center justify-center rounded-round border border-danger-border bg-surface text-caption font-bold leading-none text-danger"
    >
      !
    </span>
  );
}

/** A price slot while the cost is pending: a quiet ellipsis, said as "Checking price". */
function Pending() {
  return (
    <>
      <span aria-hidden="true">…</span>
      <span className="sr-only">Checking price</span>
    </>
  );
}

/**
 * The Published Deck's cards (#183): the deck builder's deck panel, read-only, group by group, in Spread (one plain
 * tile per copy with one card's price), Stacked (one pile per Edition with one card's price) or List (the quantity,
 * the Edition and the price of that many copies: "4 Iono · Paldea Evolved · 185 · Normal · $4.40"). No ownership
 * marks and no key. Every tile, pile and row opens the read-only card popup.
 */
export function PublishedDeckPanel({
  view,
  groups,
  prices,
  flagged,
  formatName,
  onOpen,
}: Props) {
  const base = useId();
  const issueId = `${base}-issue`;
  if (!groups.length)
    return (
      <p className="m-0 py-6 text-body text-text-muted">
        This Published Deck has no cards.
      </p>
    );
  return (
    <div className="flex flex-col gap-5">
      <span id={issueId} hidden>
        {`Has a format issue: see the ${formatName} result.`}
      </span>
      {groups.map((group, index) => (
        <section key={group.key} aria-labelledby={`${base}-group-${index}`}>
          <h3
            id={`${base}-group-${index}`}
            className="m-0 mb-2 flex items-baseline gap-2 text-meta font-semibold text-text-muted"
          >
            {group.title}
            <span className="tabular-nums text-text-subtle">
              <span className="sr-only">, </span>
              {group.copies.toString()}
              <span className="sr-only">
                {group.copies === 1n ? " card" : " cards"}
              </span>
            </span>
          </h3>
          {view === "list" ? (
            <ul className="m-0 list-none p-0">
              {group.lines.map((line) => (
                <ListRow
                  key={line.line.edition_id}
                  line={line}
                  prices={prices}
                  issueId={
                    flagged.has(line.line.edition_id) ? issueId : undefined
                  }
                  onOpen={onOpen}
                />
              ))}
            </ul>
          ) : (
            <ul className="m-0 flex list-none flex-wrap items-start gap-x-4 gap-y-3 p-0">
              {group.lines.map((line) => {
                const issue = flagged.has(line.line.edition_id)
                  ? issueId
                  : undefined;
                const price = cardPrice(prices, line.line.edition_id);
                return (
                  <li
                    key={line.line.edition_id}
                    className={`relative flex flex-wrap gap-1 rounded-card${
                      issue ? " outline-2 outline-offset-2 outline-danger" : ""
                    }`}
                  >
                    {issue && <IssueMark />}
                    {view === "spread" && line.copies ? (
                      line.copies.map((copy) => (
                        <CopyTile
                          key={copy.ordinal}
                          className="w-14 phone:w-12"
                          label={tileLabel(line, copy.ordinal, price)}
                          title={tileLabel(line, copy.ordinal, price)}
                          name={line.line.name}
                          setName={line.line.set_name}
                          collectorNumber={line.line.collector_number}
                          variant={line.variant}
                          imageUrl={line.line.image_url}
                          names={false}
                          price={price ?? <Pending />}
                          aria-describedby={issue}
                          onClick={(event: MouseEvent<HTMLButtonElement>) =>
                            onOpen(line, event.currentTarget)
                          }
                        />
                      ))
                    ) : (
                      <Pile
                        line={line}
                        price={price}
                        issueId={issue}
                        onOpen={onOpen}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

/** One pile per Edition: the top copy's art over the edges of the copies under it, "×4", and one card's price. */
function Pile({
  line,
  price,
  issueId,
  onOpen,
}: {
  line: DeckLine;
  price: string | null;
  issueId?: string;
  onOpen: OpenCard;
}) {
  const label = pileLabel(line, price);
  return (
    <button
      type="button"
      aria-label={label}
      aria-describedby={issueId}
      title={label}
      onClick={(event) => onOpen(line, event.currentTarget)}
      className="m-0 box-border flex w-16 cursor-pointer flex-col gap-1 rounded-card border-0 bg-transparent p-0 text-left font-sans text-text phone:w-14"
    >
      <span aria-hidden="true" className="relative block pb-2 pr-2">
        {line.quantity > 2n && (
          <span className="absolute bottom-0 left-2 right-0 top-2 rounded-card border border-border-strong bg-surface-raised" />
        )}
        {line.quantity > 1n && (
          <span className="absolute bottom-1 left-1 right-1 top-1 rounded-card border border-border-strong bg-surface-raised" />
        )}
        <CopyArt name={line.line.name} imageUrl={line.line.image_url} />
      </span>
      <span
        aria-hidden="true"
        className="flex items-baseline justify-between gap-1 whitespace-nowrap text-caption tabular-nums"
      >
        <span className="font-semibold">×{line.quantity.toString()}</span>
        <span className="truncate text-text-muted">{price ?? "…"}</span>
      </span>
    </button>
  );
}

/** One List row: the quantity, the Edition (which opens the card popup) and the price of that many copies. */
function ListRow({
  line,
  prices,
  issueId,
  onOpen,
}: {
  line: DeckLine;
  prices: Prices;
  issueId?: string;
  onOpen: OpenCard;
}) {
  const total = linePrice(prices, line);
  return (
    <li
      className={`grid grid-cols-[2rem_minmax(0,1fr)_5rem] items-center gap-2 border-b py-0.5 ${
        issueId ? "border-danger-border" : "border-border"
      }`}
    >
      <span className="text-right text-control font-semibold tabular-nums">
        {issueId && (
          <span aria-hidden="true" className="mr-1 font-bold text-danger">
            !
          </span>
        )}
        <span className="sr-only">Quantity </span>
        {line.quantity.toString()}
      </span>
      <button
        type="button"
        aria-describedby={issueId}
        onClick={(event) => onOpen(line, event.currentTarget)}
        className="m-0 box-border flex min-h-control min-w-0 cursor-pointer flex-col justify-center rounded-control border-0 bg-transparent px-1 text-left font-sans text-text hover:bg-surface-raised phone:min-h-tap"
      >
        <span className="block truncate text-control font-medium">
          {line.line.name}
        </span>
        <span className="block truncate text-caption text-text-subtle">
          {editionText(line)}
        </span>
      </button>
      <span className="text-right text-meta tabular-nums text-text-muted">
        {total ?? <Pending />}
      </span>
    </li>
  );
}
