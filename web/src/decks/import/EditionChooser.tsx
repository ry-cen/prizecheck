import { useEffect, useRef } from "react";
import type { ReviewLine } from "../../decks_generated";
import { editionText } from "./importModel";
import { ROW } from "./LineResolver";

/**
 * The Edition chooser under a resolved line (#212): every active Edition of its Printing with the stored price, the
 * current one pressed. Choosing one posts a fix that names it (the "your choice" Edition); the pressed button takes the
 * focus when the chooser opens.
 */
export function EditionChooser({
  line,
  onEdition,
}: {
  line: ReviewLine;
  onEdition: (editionId: string) => void;
}) {
  const group = useRef<HTMLDivElement>(null);
  useEffect(() => {
    group.current
      ?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
      ?.focus();
  }, []);
  return (
    <div
      ref={group}
      role="group"
      aria-label={`Edition for ${line.text}`}
      className="flex flex-col gap-2 rounded-panel border border-border-strong bg-surface p-3"
    >
      <p className="m-0 text-meta text-text-muted">
        Choose the Edition for these cards:
      </p>
      {line.editions.map((edition) => (
        <button
          key={edition.edition_id}
          type="button"
          aria-pressed={edition.edition_id === line.parts[0]?.edition_id}
          onClick={() => onEdition(edition.edition_id)}
          className={`${ROW} aria-pressed:border-accent-border aria-pressed:bg-surface-selected`}
        >
          {editionText(edition)}
        </button>
      ))}
    </div>
  );
}
