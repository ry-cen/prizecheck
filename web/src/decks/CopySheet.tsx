import type { RefObject } from "react";
import { Dialog } from "../ui/Dialog";
import { CopyArt } from "../ui/CopyTile";
import {
  copyStateText,
  editionText,
  kindText,
  type DeckLine,
} from "./deckListModel";

type Props = {
  /** The line shown, or null while closed. */
  line: DeckLine | null;
  /** The copy that was tapped (1-based), or null for the whole line (a Stacked pile or a List row). */
  ordinal: number | null;
  onClose: () => void;
  returnFocus: RefObject<HTMLElement | null>;
};

/**
 * What a copy is and where it is (#176): the card, its Edition and kind, and how its line's copies split
 * between this Deck, other Locations and not owned. Read-only here; #177 adds ±1 and Swap this copy for, and
 * #179 adds Gather.
 */
export function CopySheet({ line, ordinal, onClose, returnFocus }: Props) {
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
              <li>{line.here.toString()} in this Deck</li>
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
              <li>{line.missing.toString()} not owned</li>
            </ul>
          </section>
        </div>
      )}
    </Dialog>
  );
}
