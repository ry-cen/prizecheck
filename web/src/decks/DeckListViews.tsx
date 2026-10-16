import {
  useId,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { Minus, Plus } from "lucide-react";
import { Button } from "../ui/Button";
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

/** Editing a line from its controls (#177): Delete or Backspace takes one copy off, and a press may become a drag
 * onto the library (desktop, mouse or pen). */
export type LineEditing = {
  onRemove: (line: DeckLine, control: HTMLElement) => void;
  onDragStart: (line: DeckLine, event: PointerEvent<HTMLElement>) => void;
  /** A List row's −1 or +1: one copy off or on. `control` is the button pressed. */
  onStep: (line: DeckLine, delta: bigint, control: HTMLElement) => void;
};

/** The props every copy, pile and row control gets for editing: the keys, the drag and the line's Edition id (the
 * page finds a line's controls by it to keep focus on the line after a copy leaves). */
function editProps(line: DeckLine, editing: LineEditing | undefined) {
  if (!editing) return {};
  return {
    "data-edition-id": line.line.edition_id,
    "aria-keyshortcuts": "Delete Backspace",
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      event.preventDefault();
      editing.onRemove(line, event.currentTarget);
    },
    onPointerDown: (event: PointerEvent<HTMLElement>) =>
      editing.onDragStart(line, event),
  };
}

type Props = {
  view: DeckView;
  groups: readonly LineGroup[];
  onOpen: OpenSheet;
  /** Lines (Edition ids) a card-level issue of the Target Format's result names (#178): each is outlined and
   * marked "!", and its controls are described as having a format issue. */
  flagged?: ReadonlySet<string>;
  /** Editing (#177): without it the controls only open the copy sheet. */
  editing?: LineEditing;
};

const NO_LINES: ReadonlySet<string> = new Set();

/** The outline and the "!" mark on a line with a card-level format issue: the mark, not the colour, says it. */
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

/**
 * The Deck List in one of its three views (#176), group by group, each under a heading with its copy count:
 *
 * - Spread: one CopyTile per copy, each drawn in its own state (solid, dashed ↻, ghost $);
 * - Stacked: one pile per Edition with a summary such as "×4 1↻ 1$";
 * - List: one row per Edition with its quantity, the Edition, its ownership counts and the line's price.
 *
 * Every tile, pile and row opens the copy sheet. With `editing` (#177), Delete or Backspace on one takes a copy of its
 * line off the Deck List, and dragging one onto the library does too.
 */
export function DeckListBody({
  view,
  groups,
  onOpen,
  flagged = NO_LINES,
  editing,
}: Props) {
  // Heading ids come from useId and the group's position: a group key holds a card name (spaces, apostrophes),
  // which is no valid id. The key stays React's key only.
  const base = useId();
  // One description every flagged control points at, so their accessible names stay as they are.
  const issueId = `${base}-issue`;
  if (!groups.length)
    return (
      <p className="m-0 py-6 text-body text-text-muted">
        No cards on this Deck List yet.
      </p>
    );
  return (
    <div className="flex flex-col gap-5">
      <span id={issueId} hidden>
        Has a format issue: see the result next to the Target Format.
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
                  onOpen={onOpen}
                  editing={editing}
                  issueId={
                    flagged.has(line.line.edition_id) ? issueId : undefined
                  }
                />
              ))}
            </ul>
          ) : (
            <ul className="m-0 flex list-none flex-wrap items-start gap-x-4 gap-y-3 p-0">
              {group.lines.map((line) => {
                const issue = flagged.has(line.line.edition_id)
                  ? issueId
                  : undefined;
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
                          label={copyLabel(line, copy)}
                          title={copyLabel(line, copy)}
                          name={line.line.name}
                          setName={line.line.set_name}
                          collectorNumber={line.line.collector_number}
                          variant={line.variant}
                          imageUrl={line.line.image_url}
                          names={false}
                          state={copy.state}
                          aria-describedby={issue}
                          {...editProps(line, editing)}
                          onClick={(event: MouseEvent<HTMLButtonElement>) =>
                            onOpen(line, copy.ordinal, event.currentTarget)
                          }
                        />
                      ))
                    ) : (
                      <Pile
                        line={line}
                        onOpen={onOpen}
                        issueId={issue}
                        editing={editing}
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

/** One pile per Edition: the top copy's art over the edges of the copies under it, and the summary. One
 * button, so a phone's 44 px tap area is the whole pile. */
function Pile({
  line,
  onOpen,
  issueId,
  editing,
}: {
  line: DeckLine;
  onOpen: OpenSheet;
  issueId?: string;
  editing?: LineEditing;
}) {
  const label = pileLabel(line);
  // Lent copies (#253) are owned, out of the Deck: drawn as owned elsewhere, never as not owned.
  const top =
    line.missing > line.lent
      ? "missing"
      : line.elsewhere > 0n || line.lent > 0n
        ? "elsewhere"
        : "here";
  return (
    <button
      type="button"
      aria-label={label}
      aria-describedby={issueId}
      title={label}
      {...editProps(line, editing)}
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
function ListRow({
  line,
  onOpen,
  issueId,
  editing,
}: {
  line: DeckLine;
  onOpen: OpenSheet;
  issueId?: string;
  editing?: LineEditing;
}) {
  return (
    <li
      className={`grid ${
        editing
          ? "grid-cols-[2rem_minmax(0,1fr)_auto_4.5rem_auto] phone:grid-cols-[2rem_minmax(0,1fr)_auto_4.5rem]"
          : "grid-cols-[2rem_minmax(0,1fr)_auto_4.5rem]"
      } items-center gap-2 border-b py-0.5 ${
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
        {...editProps(line, editing)}
        onClick={(event) => onOpen(line, null, event.currentTarget)}
        className="m-0 box-border flex min-h-control min-w-0 cursor-pointer flex-col justify-center rounded-control border-0 bg-transparent px-1 text-left font-sans text-text hover:bg-surface-raised phone:min-h-tap"
      >
        <span className="block truncate text-control font-medium">
          {line.line.name}
        </span>
        <span className="block truncate text-caption text-text-subtle">
          {editionText(line)}
        </span>
        {line.loans.length > 0 && (
          <span className="block truncate text-caption text-text-muted">
            {line.loans.join(" · ")}
          </span>
        )}
      </button>
      <span className="whitespace-nowrap text-meta tabular-nums">
        <span aria-hidden="true" className="flex gap-1.5">
          {line.here > 0n && <span>{line.here.toString()}✓</span>}
          {line.elsewhere > 0n && (
            <span className="text-accent-strong">
              {line.elsewhere.toString()}↻
            </span>
          )}
          {line.lent > 0n && (
            <span className="text-text-muted">{line.lent.toString()} lent</span>
          )}
          {line.missing > line.lent && (
            <span className="text-text-muted">
              {(line.missing - line.lent).toString()}$
            </span>
          )}
        </span>
        <span className="sr-only">{stateWords(line)}</span>
      </span>
      <LinePrice line={line} />
      {editing && (
        <span className="flex gap-1 phone:col-span-full phone:justify-end">
          <Button
            icon={Minus}
            label={`Remove one ${line.line.name}`}
            onClick={(event) => editing.onStep(line, -1n, event.currentTarget)}
          />
          <Button
            icon={Plus}
            label={`Add one ${line.line.name}`}
            onClick={(event) => editing.onStep(line, 1n, event.currentTarget)}
          />
        </span>
      )}
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
