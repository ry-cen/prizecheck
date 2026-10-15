import { useEffect, useRef } from "react";
import type { ReviewLine } from "../../decks_generated";
import { editionText } from "./importModel";
import { ROW } from "./LineResolver";

/**
 * The Edition chooser under a resolved line (#212): every active Edition of its Printing with the stored price, the
 * Edition of the copies to get pressed (none when owned copies cover the line). Choosing one posts a fix that names it (the "your choice" Edition); the pressed button takes the
 * focus when the chooser opens, unless it sits inside Change (EnergyChooser), which places the focus itself.
 */
export function EditionChooser({
  line,
  onEdition,
  focus = true,
}: {
  line: ReviewLine;
  onEdition: (editionId: string) => void;
  focus?: boolean;
}) {
  const group = useRef<HTMLDivElement>(null);
  // The Edition the copies to get have (#214: owned copies come first and keep their own Editions).
  const newEdition = line.parts.find(
    (part) => part.source === "new"
  )?.edition_id;
  useEffect(() => {
    if (!focus) return;
    group.current
      ?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
      ?.focus();
  }, [focus]);
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
          aria-pressed={edition.edition_id === newEdition}
          onClick={() => onEdition(edition.edition_id)}
          className={`${ROW} aria-pressed:border-accent-border aria-pressed:bg-surface-selected`}
        >
          {editionText(edition)}
        </button>
      ))}
    </div>
  );
}
