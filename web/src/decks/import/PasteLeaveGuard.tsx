import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
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

/** How a save ended, as the page tells the guard: it landed (and `open` goes to the saved Deck), or it failed. */
export type Settle =
  { kind: "landed"; open: () => void } | { kind: "failed"; message: string };

type Mode = "unapplied" | "saving" | "landed" | "failed";

type Words = {
  title: string;
  close: string;
  body: ReactNode;
  keep: string;
  go: string;
};

const RETRY = "or keep editing to try again.";

function wordsFor(mode: Mode, flow: Flow, message: string): Words {
  if (mode === "unapplied")
    return flow.kind === "copy"
      ? {
          title: "Discard your review changes?",
          close: "Back to the review",
          body: (
            <p className="m-0 text-body">
              The cards you picked or removed while checking this list won't be
              kept.
            </p>
          ),
          keep: "Keep editing",
          go: "Discard",
        }
      : {
          title: "Discard this pasted list?",
          close: "Back to the pasted list",
          body: (
            <p className="m-0 text-body">
              {flow.kind === "replace"
                ? `Your pasted list will be discarded. ${flow.deckName}'s Deck List stays as it was.`
                : "Your pasted list will be discarded."}
            </p>
          ),
          keep: "Keep editing",
          go: "Discard",
        };
  if (mode === "failed")
    return {
      title:
        flow.kind === "copy"
          ? "Your copy didn't save"
          : "Your list didn't save",
      close: "Back to the list",
      body: (
        <>
          <p className="m-0 text-body">{message}</p>
          <p className="m-0 text-body">
            {flow.kind === "copy"
              ? `Discard your review changes, ${RETRY}`
              : `Discard your pasted list, ${RETRY}`}
          </p>
        </>
      ),
      keep: "Keep editing",
      go: "Discard",
    };
  // Saving, and a save that has landed while the question is open: the same words, so nothing moves under the pointer.
  return {
    title: "Your list is still saving",
    close: "Back to the list",
    body: (
      <p className="m-0 text-body">
        {flow.kind === "replace"
          ? `If you leave and it doesn't save, your pasted list for ${flow.deckName} is lost.`
          : flow.kind === "copy"
            ? "If you leave and it doesn't save, your review changes are lost."
            : "If you leave and it doesn't save, your pasted list is lost."}
      </p>
    ),
    keep: "Stay",
    go: "Leave",
  };
}

/**
 * The import and Replace list… pages' leave guard (m13 s1), the Trade Proposal builder's pattern: while a draft hasn't
 * been applied, leaving by any in-app route (the back link, a shell tab, the browser's Back) asks "Discard this pasted
 * list?" (or, for a copy, "Discard your review changes?") with Keep editing, the default, or Discard. While a save is
 * pending it asks "Your list is still saving" and warns that a failure loses the paste, with Stay or Leave. A reload or
 * a closed tab gets the browser's own warning in both cases. `pending` is read at the moment of the leave, so a page
 * that has just saved can clear it and navigate with no render in between.
 *
 * The page tells the guard how a save ended with `settle`. A save that lands with no question open goes straight to the
 * saved Deck (`open`); one that lands under the question leaves it open, in the same words, and the collector's answer
 * decides: Stay opens the Deck, Leave goes where they were going. A save that fails under the question turns it into
 * "didn't save", with Keep editing or Discard. Render the returned `dialog` inside the page.
 */
export function usePasteLeaveGuard(
  pending: () => Pending,
  flow: Flow
): {
  dialog: ReactNode;
  settle: (outcome: Settle) => void;
  /** Whether the collector has accepted Leave: the page is on its way out, so a save settling now treats them as gone. */
  left: () => boolean;
} {
  const check = useRef(pending);
  check.current = pending;
  const [view, setView] = useState<{ mode: Mode; message: string } | null>(
    null
  );
  // Read by handlers that may run before the next render, such as a save landing as the collector answers.
  const modeRef = useRef<Mode | null>(null);
  const leaveRef = useRef<() => void>(() => undefined);
  const stayRef = useRef<() => void>(() => undefined);
  const returnTo = useRef<HTMLElement | null>(null);
  // Set the moment Leave is accepted, before the dialog closes or the router moves, so a response that overtakes the
  // navigation is handled as if the page had already gone. Cleared by the next attempt to leave (the first one may have
  // been stopped by another guard).
  const leavingRef = useRef(false);
  const keepRef = useRef<HTMLButtonElement>(null);

  const show = useCallback((mode: Mode, message = "") => {
    modeRef.current = mode;
    setView({ mode, message });
  }, []);
  const close = useCallback(() => {
    modeRef.current = null;
    setView(null);
  }, []);

  // Read through refs only, so it is made once.
  const guard = useMemo<LeaveGuard>(
    () => ({
      blocks: () => {
        leavingRef.current = false;
        return check.current() !== "none";
      },
      ask: (leave) => {
        leavingRef.current = false;
        leaveRef.current = leave;
        // Asked again while a question is already settled on (Back with it open): it keeps its words.
        if (modeRef.current === "failed" || modeRef.current === "landed")
          return;
        const active = document.activeElement;
        // Focus inside another dialog can't be returned to once it closes with the page change.
        returnTo.current =
          active instanceof HTMLElement &&
          active !== document.body &&
          !active.closest("dialog")
            ? active
            : null;
        show(check.current() === "saving" ? "saving" : "unapplied");
      },
    }),
    [show]
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

  const settle = useCallback(
    (outcome: Settle) => {
      // Leave was accepted: the page is going, and the collector's choice decides where.
      if (leavingRef.current) return;
      if (outcome.kind === "failed") {
        if (modeRef.current === "saving") show("failed", outcome.message);
        return;
      }
      if (modeRef.current === "saving") {
        stayRef.current = outcome.open;
        show("landed");
        return;
      }
      if (modeRef.current !== null) close();
      outcome.open();
    },
    [show, close]
  );

  // Stay, Keep editing, Escape and the close button. A save that landed under the question opens the Deck now.
  function stay() {
    const mode = modeRef.current;
    if (mode === null) return;
    close();
    if (mode === "landed") stayRef.current();
  }
  function leave() {
    if (modeRef.current === null) return;
    leavingRef.current = true;
    close();
    leaveRef.current();
  }

  // A save that fails under the question turns it into "didn't save": focus moves to Keep editing, which the dialog's
  // own opening focus can't do because the dialog is already open.
  const failedNow = view?.mode === "failed";
  useEffect(() => {
    if (failedNow) keepRef.current?.focus();
  }, [failedNow]);

  const words = wordsFor(view?.mode ?? "unapplied", flow, view?.message ?? "");
  const dialog = (
    <Dialog
      open={view !== null}
      onClose={stay}
      title={words.title}
      closeLabel={words.close}
      returnFocus={returnTo}
    >
      <div className="flex flex-col gap-4">
        {/* The failure's details are a polite status: this region is always there, so filling it is announced once. */}
        <div role="status" className="flex flex-col gap-2">
          {failedNow ? words.body : null}
        </div>
        {!failedNow && <div className="flex flex-col gap-2">{words.body}</div>}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            ref={keepRef}
            data-autofocus
            variant="secondary"
            onClick={stay}
          >
            {words.keep}
          </Button>
          <Button variant="danger" onClick={leave}>
            {words.go}
          </Button>
        </div>
      </div>
    </Dialog>
  );
  return { dialog, settle, left: () => leavingRef.current };
}
