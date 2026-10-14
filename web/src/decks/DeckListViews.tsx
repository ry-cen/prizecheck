import { useId, useRef, type MouseEvent } from "react";
import { CopyArt, CopyTile } from "../ui/CopyTile";
import { useEditionPriceRow } from "../EditionPrice";
import {
  copyLabel,
  editionText,
  lineTotal,
  pileLabel,
  pileSummary,
  stateWords,
  type DeckLine,
  type DeckView,
  type LineGroup,
} from "./deckListModel";

/** Opens the copy sheet for a line, on one copy (Spread) or the whole line (Stacked, List). `opener` is the
 * control that was pressed, for focus return. */
export type OpenSheet = (
  line: DeckLine,
  ordinal: number | null,
  opener: HTMLElement
) => void;

type Props = {
  view: DeckView;
  groups: readonly LineGroup[];
  onOpen: OpenSheet;
};

/**
 * The Deck List in one of its three views (#176), group by group, each under a heading with its copy count:
 *
 * - Spread: one CopyTile per copy, each drawn in its own state (solid, dashed ↻, ghost $);
 * - Stacked: one pile per Edition with a summary such as "×4 1↻ 1$";
 * - List: one row per Edition with its quantity, the Edition, its ownership counts and the line's price.
 *
 * Every tile, pile and row opens the copy sheet. #177 adds editing (drag, Delete, ±1) on the same controls.
 */
export function DeckListBody({ view, groups, onOpen }: Props) {
  // Heading ids come from useId and the group's position: a group key holds a card name (spaces, apostrophes),
  // which is no valid id. The key stays React's key only.
  const base = useId();
  if (!groups.length)
    return (
      <p className="m-0 py-6 text-body text-text-muted">
        No cards on this Deck List yet.
      </p>
    );
  return (
    <div className="flex flex-col gap-5">
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
                  onOpen={onOpen}
                />
              ))}
            </ul>
          ) : (
            <ul className="m-0 flex list-none flex-wrap items-start gap-x-4 gap-y-3 p-0">
              {group.lines.map((line) => (
                <li key={line.line.edition_id} className="flex flex-wrap gap-1">
                  {view === "spread" && line.copies ? (
                    line.copies.map((copy) => (
                      <CopyTile
                        key={copy.ordinal}
                        className="w-14 phone:w-12"
                        label={copyLabel(line, copy)}
                        title={copyLabel(line, copy)}
                        name={line.line.name}
                        setName={line.line.set_name}
                        collectorNumber={line.line.collector_number}
                        variant={line.variant}
                        imageUrl={line.line.image_url}
                        names={false}
                        state={copy.state}
                        onClick={(event: MouseEvent<HTMLButtonElement>) =>
                          onOpen(line, copy.ordinal, event.currentTarget)
                        }
                      />
                    ))
                  ) : (
                    <Pile line={line} onOpen={onOpen} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

/** One pile per Edition: the top copy's art over the edges of the copies under it, and the summary. One
 * button, so a phone's 44 px tap area is the whole pile. */
function Pile({ line, onOpen }: { line: DeckLine; onOpen: OpenSheet }) {
  const label = pileLabel(line);
  const top =
    line.missing > 0n ? "missing" : line.elsewhere > 0n ? "elsewhere" : "here";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => onOpen(line, null, event.currentTarget)}
      className="m-0 box-border flex w-16 cursor-pointer flex-col gap-1 rounded-card border-0 bg-transparent p-0 text-left font-sans text-text phone:w-14"
    >
      <span aria-hidden="true" className="relative block pb-2 pr-2">
        {line.quantity > 2n && (
          <span className="absolute bottom-0 left-2 right-0 top-2 rounded-card border border-border-strong bg-surface-raised" />
        )}
        {line.quantity > 1n && (
          <span className="absolute bottom-1 left-1 right-1 top-1 rounded-card border border-border-strong bg-surface-raised" />
        )}
        <CopyArt
          name={line.line.name}
          imageUrl={line.line.image_url}
          state={top}
        />
      </span>
      <span
        aria-hidden="true"
        className="block whitespace-nowrap text-caption font-semibold tabular-nums"
      >
        {pileSummary(line)}
      </span>
    </button>
  );
}

/** One List row: quantity, the Edition (which opens the copy sheet), ownership counts and the line's price. */
function ListRow({ line, onOpen }: { line: DeckLine; onOpen: OpenSheet }) {
  return (
    <li className="grid grid-cols-[2rem_minmax(0,1fr)_auto_4.5rem] items-center gap-2 border-b border-border py-0.5">
      <span className="text-right text-control font-semibold tabular-nums">
        <span className="sr-only">Quantity </span>
        {line.quantity.toString()}
      </span>
      <button
        type="button"
        onClick={(event) => onOpen(line, null, event.currentTarget)}
        className="m-0 box-border flex min-h-control min-w-0 cursor-pointer flex-col justify-center rounded-control border-0 bg-transparent px-1 text-left font-sans text-text hover:bg-surface-raised phone:min-h-tap"
      >
        <span className="block truncate text-control font-medium">
          {line.line.name}
        </span>
        <span className="block truncate text-caption text-text-subtle">
          {editionText(line)}
        </span>
      </button>
      <span className="whitespace-nowrap text-meta tabular-nums">
        <span aria-hidden="true" className="flex gap-1.5">
          {line.here > 0n && <span>{line.here.toString()}✓</span>}
          {line.elsewhere > 0n && (
            <span className="text-accent-strong">
              {line.elsewhere.toString()}↻
            </span>
          )}
          {line.missing > 0n && (
            <span className="text-text-muted">{line.missing.toString()}$</span>
          )}
        </span>
        <span className="sr-only">{stateWords(line)}</span>
      </span>
      <LinePrice line={line} />
    </li>
  );
}

/** The price of the line's copies at the Edition's cached price, or a dash when it has none. */
function LinePrice({ line }: { line: DeckLine }) {
  const slot = useRef<HTMLSpanElement>(null);
  const settled = useEditionPriceRow(line.line.edition_id, slot);
  const row = settled?.kind === "row" ? settled.row : null;
  const quoted = row?.status === "quote" && row.amount !== null ? row : null;
  return (
    <span
      ref={slot}
      className="text-right text-meta tabular-nums text-text-muted"
      title={quoted ? `${line.quantity} × ${quoted.display_amount}` : undefined}
    >
      {!settled ? (
        <>
          <span aria-hidden="true">…</span>
          <span className="sr-only">Checking price</span>
        </>
      ) : quoted ? (
        lineTotal(quoted.amount!, line.line.quantity)
      ) : (
        <>
          <span aria-hidden="true">—</span>
          <span className="sr-only">No price</span>
        </>
      )}
    </span>
  );
}
