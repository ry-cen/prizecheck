import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLeaveGuard, type LeaveGuard } from "../../shell/useRoute";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";

/**
 * Whether the import page holds something the collector would lose by leaving: a pasted list, or, for a copy of a
 * Published Deck (which has no text), the fixes they made to its lines. A Deck name alone is not one.
 */
export function pasteIsUnapplied({
  text,
  picks,
  drops,
}: {
  text: string;
  picks: number;
  drops: number;
}): boolean {
  return text.trim() !== "" || picks > 0 || drops > 0;
}

/**
 * The import and Replace list… pages' leave guard (m13 s1), the Trade Proposal builder's pattern: while a pasted list
 * hasn't been applied, leaving by any in-app route (the back link, a shell tab, the browser's Back) asks "Discard this
 * pasted list?" with Keep editing, the default, or Discard, and a reload or a closed tab gets the browser's own
 * warning. `unapplied` is read at the moment of the leave, so a page that has just saved can clear it and navigate
 * with no render in between. Render the returned `dialog` inside the page.
 */
export function usePasteLeaveGuard(
  unapplied: () => boolean,
  /** The Deck whose Deck List a Replace list… is for; null when the list was going into a new Deck. */
  deckName: string | null
): { dialog: ReactNode } {
  const check = useRef(unapplied);
  check.current = unapplied;
  const [asking, setAsking] = useState<{ leave: () => void } | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  // Read through the ref only, so it is made once.
  const guard = useMemo<LeaveGuard>(
    () => ({
      blocks: () => check.current(),
      ask: (leave) => {
        const active = document.activeElement;
        // Focus inside another dialog can't be returned to once it closes with the page change.
        returnTo.current =
          active instanceof HTMLElement &&
          active !== document.body &&
          !active.closest("dialog")
            ? active
            : null;
        setAsking({ leave });
      },
    }),
    []
  );
  useLeaveGuard(guard);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!check.current()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const dialog = (
    <Dialog
      open={asking !== null}
      onClose={() => setAsking(null)}
      title="Discard this pasted list?"
      closeLabel="Back to the pasted list"
      returnFocus={returnTo}
    >
      <div className="flex flex-col gap-4">
        <p className="m-0 text-body">
          {deckName === null
            ? "Your pasted list will be discarded."
            : `Your pasted list will be discarded. ${deckName}'s Deck List stays as it was.`}
        </p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            data-autofocus
            variant="secondary"
            onClick={() => setAsking(null)}
          >
            Keep editing
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (!asking) return;
              const { leave } = asking;
              setAsking(null);
              leave();
            }}
          >
            Discard
          </Button>
        </div>
      </div>
    </Dialog>
  );
  return { dialog };
}
