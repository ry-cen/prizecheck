import { useEffect, useRef } from "react";
import type { ReviewLine } from "../../decks_generated";
import { EditionChooser } from "./EditionChooser";
import { printingText, type Pick } from "./importModel";
import { ROW } from "./LineResolver";

/**
 * Change, under a Basic Energy line matched by type (#213): every Basic Energy Printing of its type, newest first, with
 * the current one pressed, then the Editions of the current one. Choosing a Printing posts it as the line's card, and
 * its Edition follows the add-by-Printing rule. Choosing an Edition posts that Edition. The pressed Printing takes the
 * focus when Change opens.
 */
export function EnergyChooser({
  line,
  onPick,
  onEdition,
}: {
  line: ReviewLine;
  onPick: (pick: Pick) => void;
  onEdition: (editionId: string) => void;
}) {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
      ?.focus();
  }, []);
  return (
    <div
      role="group"
      aria-label={`Change ${line.text}`}
      className="flex flex-col gap-2 rounded-panel border border-border-strong bg-surface p-3"
    >
      <p className="m-0 text-meta text-text-muted">
        Basic Energy of this type, newest first:
      </p>
      <ul
        ref={list}
        aria-label="Basic Energy cards"
        className="m-0 flex list-none flex-col gap-1 p-0"
      >
        {line.candidates.map((candidate) => (
          <li key={candidate.printing_id}>
            <button
              type="button"
              aria-pressed={
                candidate.printing_id === line.printing?.printing_id
              }
              onClick={() => onPick({ printing_id: candidate.printing_id })}
              className={`${ROW} aria-pressed:border-accent-border aria-pressed:bg-surface-selected`}
            >
              {printingText(candidate)}
            </button>
          </li>
        ))}
      </ul>
      <EditionChooser line={line} onEdition={onEdition} focus={false} />
    </div>
  );
}
