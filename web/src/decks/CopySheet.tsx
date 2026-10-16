import type { RefObject } from "react";
import type { BrowseEdition } from "../catalog_browse_generated";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { CopyArt } from "../ui/CopyTile";
import {
  copyStateText,
  editionText,
  kindText,
  type DeckLine,
} from "./deckListModel";
import { DeckListStepper, EditFeedbackLine } from "./DeckListStepper";
import { SwapList } from "./SwapList";
import type { EditFeedback } from "./useDeckListEdits";

type Props = {
  /** The line shown, or null while closed. */
  line: DeckLine | null;
  /** The copy that was tapped (1-based), or null for the whole line (a Stacked pile or a List row). */
  ordinal: number | null;
  onClose: () => void;
  returnFocus: RefObject<HTMLElement | null>;
  /** Gather: open the Pick List on this line's Edition (#179). Offered while copies are owned elsewhere. */
  onGather?: (editionId: string) => void;
  /** Editing (#177). Without it the sheet is read-only. */
  editing?: {
    deckId: string;
    /** Copies of the line's Edition on the Deck List, edits on their way included. */
    quantity: bigint;
    /** −1 or +1 on the line. */
    onChange: (delta: bigint) => void;
    /** Swap this copy for another Edition of the same Card Identity. */
    onSwap: (row: BrowseEdition) => void;
    feedback: EditFeedback | null;
    /** Feedback with this id or lower came before the sheet opened. */
    since: number;
  };
};

/**
 * What a copy is and where it is (#176): the card, its Edition and kind, and how its line's copies split
 * between this Deck, other Locations and not owned, with Gather (#179) while copies are owned elsewhere. Editing
 * (#177) adds −1 / N on Deck List / +1, the last edit's words with its Undo, and Swap this copy for another Edition
 * of the same Card Identity.
 */
export function CopySheet({
  line,
  ordinal,
  onClose,
  returnFocus,
  onGather,
  editing,
}: Props) {
  const copy =
    line && ordinal !== null && line.copies
      ? (line.copies.find((item) => item.ordinal === ordinal) ?? null)
      : null;
  return (
    <Dialog
      open={line !== null}
      onClose={onClose}
      title={line?.line.name ?? ""}
      closeLabel="Close card"
      returnFocus={returnFocus}
    >
      {line && (
        <div className="flex flex-col gap-4 text-body">
          <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-3">
            <CopyArt
              name={line.line.name}
              imageUrl={line.line.image_url}
              state={copy?.state ?? "here"}
            />
            <dl className="m-0 flex min-w-0 flex-col gap-1">
              <dt className="sr-only">Edition</dt>
              <dd className="m-0 wrap-anywhere">{editionText(line)}</dd>
              <dt className="sr-only">Card type</dt>
              <dd className="m-0 text-meta text-text-muted">
                {kindText(line.line)}
              </dd>
              {line.line.identity_name !== line.line.name && (
                <>
                  <dt className="sr-only">Card Identity</dt>
                  <dd className="m-0 text-meta text-text-muted">
                    Counts as {line.line.identity_name}
                  </dd>
                </>
              )}
            </dl>
          </div>
          {copy && (
            <p className="m-0">
              This copy ({copy.ordinal} of {line.quantity.toString()}):{" "}
              <strong>{copyStateText(copy)}</strong>
            </p>
          )}
          <section
            aria-labelledby="copy-sheet-copies"
            className="flex flex-col gap-2"
          >
            <h3 id="copy-sheet-copies" className="m-0 text-meta font-semibold">
              {line.quantity.toString()} on the Deck List
            </h3>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              <li>
                {line.here.toString()} in this Deck
                {line.reservedFor.length > 0 && (
                  <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 pl-4 text-meta text-text-muted">
                    {line.reservedFor.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                )}
              </li>
              <li>
                {line.elsewhere.toString()} owned elsewhere
                {line.elsewhere > 0n && line.places.length > 0 && (
                  <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 pl-4 text-meta text-text-muted">
                    {line.places.map((place, index) => (
                      <li key={index}>
                        {place.quantity.toString()} in {place.label}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
              {line.lent > 0n && (
                <li>
                  {line.lent.toString()} lent out
                  <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 pl-4 text-meta text-text-muted">
                    {line.lentTo.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                </li>
              )}
              <li>{(line.missing - line.lent).toString()} not owned</li>
            </ul>
          </section>
          {editing && (
            <div className="flex flex-col gap-1">
              <DeckListStepper
                quantity={editing.quantity}
                onChange={editing.onChange}
              />
              <EditFeedbackLine
                feedback={editing.feedback}
                since={editing.since}
              />
            </div>
          )}
          {onGather && line.elsewhere > 0n && (
            <Button
              variant="primary"
              className="self-start"
              onClick={() => onGather(line.line.edition_id)}
            >
              Gather
            </Button>
          )}
          {editing && (
            <SwapList
              key={line.line.identity_id}
              deckId={editing.deckId}
              identityId={line.line.identity_id}
              editionId={line.line.edition_id}
              onSwap={editing.onSwap}
            />
          )}
        </div>
      )}
    </Dialog>
  );
}
