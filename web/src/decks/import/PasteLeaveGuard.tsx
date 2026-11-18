import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLeaveGuard, type LeaveGuard } from "../../shell/useRoute";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";

/**
 * Whether the import page holds something the collector would lose by leaving: a pasted list, or, for a copy of a
 * Published Deck (which has no text), the fixes they made to its lines. A Deck name alone is not one.
 */
export function draftIsUnapplied({
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

/** What leaving would lose right now: nothing, a draft that hasn't been saved, or a save whose outcome isn't known. */
export type Pending = "none" | "unapplied" | "saving";

/** What the page is for, which decides the words: Replace list… (a Deck's name), a new Deck, or a copy of a Published Deck. */
export type Flow =
  { kind: "replace"; deckName: string } | { kind: "new" } | { kind: "copy" };

const UNAPPLIED: Record<
  Flow["kind"],
  { title: string; close: string; body: (flow: Flow) => string }
> = {
  replace: {
    title: "Discard this pasted list?",
    close: "Back to the pasted list",
    body: (flow) =>
      `Your pasted list will be discarded. ${flow.kind === "replace" ? flow.deckName : ""}'s Deck List stays as it was.`,
  },
  new: {
    title: "Discard this pasted list?",
    close: "Back to the pasted list",
    body: () => "Your pasted list will be discarded.",
  },
  copy: {
    title: "Discard your review changes?",
    close: "Back to the review",
    body: () =>
      "The cards you picked or removed while checking this list won't be kept.",
  },
};

const SAVING = {
  title: "Your list is still saving",
  close: "Back to the list",
  body: (flow: Flow) =>
    flow.kind === "replace"
      ? `Leave now and you won't see whether it replaced ${flow.deckName}'s Deck List.`
      : "Leave now and you won't see whether it saved.",
};

/**
 * The import and Replace list… pages' leave guard (m13 s1), the Trade Proposal builder's pattern: while a draft hasn't
 * been applied, leaving by any in-app route (the back link, a shell tab, the browser's Back) asks "Discard this pasted
 * list?" (or, for a copy, "Discard your review changes?") with Keep editing, the default, or Discard. While a save is
 * pending it asks "Your list is still saving" with Stay or Leave, because leaving would hide how it ended. A reload or a
 * closed tab gets the browser's own warning in both cases. `pending` is read at the moment of the leave, so a page that
 * has just saved can clear it and navigate with no render in between. Render the returned `dialog` inside the page.
 */
export function usePasteLeaveGuard(
  pending: () => Pending,
  flow: Flow
): { dialog: ReactNode } {
  const check = useRef(pending);
  check.current = pending;
  // The question keeps the words it was asked with, even if the page's state moves on while it is open.
  const [asking, setAsking] = useState<{
    leave: () => void;
    pending: "unapplied" | "saving";
  } | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  // Read through the ref only, so it is made once.
  const guard = useMemo<LeaveGuard>(
    () => ({
      blocks: () => check.current() !== "none",
      ask: (leave) => {
        const active = document.activeElement;
        // Focus inside another dialog can't be returned to once it closes with the page change.
        returnTo.current =
          active instanceof HTMLElement &&
          active !== document.body &&
          !active.closest("dialog")
            ? active
            : null;
        const now = check.current();
        setAsking({
          leave,
          pending: now === "saving" ? "saving" : "unapplied",
        });
      },
    }),
    []
  );
  useLeaveGuard(guard);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (check.current() === "none") return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const words = asking?.pending === "saving" ? SAVING : UNAPPLIED[flow.kind];
  const saving = asking?.pending === "saving";
  const dialog = (
    <Dialog
      open={asking !== null}
      onClose={() => setAsking(null)}
      title={words.title}
      closeLabel={words.close}
      returnFocus={returnTo}
    >
      <div className="flex flex-col gap-4">
        <p className="m-0 text-body">{words.body(flow)}</p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            data-autofocus
            variant="secondary"
            onClick={() => setAsking(null)}
          >
            {saving ? "Stay" : "Keep editing"}
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
            {saving ? "Leave" : "Discard"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
  return { dialog };
}
