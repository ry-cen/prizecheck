import type { PendingLine, PendingLoans } from "../social_generated";

/**
 * What one Deck is waiting on from Friends (`GET /api/loans/pending`): copies asked for and copies promised but not yet
 * received, per card. Information only; the Want List's counts never take it off what is still needed.
 *
 * - `idle`: no Deck in scope (All Decks shows none).
 * - `loading`: the first read for this Deck.
 * - `ready`: its answer; `stale` once a later read failed, so the screen says it may be out of date and never shows 0.
 * - `failed`: the first read failed; the screen says so instead of showing nothing asked for.
 */
export type PendingState =
  | { kind: "idle" }
  | { kind: "loading"; deckId: string }
  | {
      kind: "ready";
      deckId: string;
      lines: Map<string, PendingLine>;
      stale: boolean;
    }
  | { kind: "failed"; deckId: string };

/** Why a read is asked for. `return`: the window took focus or the page became visible. `signal`: the inbox pulse
 * moved, Loans changed outside the Loans tab, or this tab sent a request. `retry`: the collector asked. */
export type PendingTrigger = "return" | "signal" | "retry";

export type PendingReaderOptions = {
  read: (deckId: string, signal: AbortSignal) => Promise<PendingLoans>;
  visible: () => boolean;
  onState: (state: PendingState) => void;
};

export type PendingReader = {
  /** The Deck in scope (null for All Decks) and the pins of the Want List answer shown for it: its owner, settings
   * and Deck List revisions as one value. New pins for the same Deck read again, keeping the answer on screen. */
  setScope: (deckId: string | null, pins: string) => void;
  trigger: (why: PendingTrigger) => void;
  /** The window lost focus or the page was hidden: the next return reads. */
  leave: () => void;
  dispose: () => void;
};

/**
 * The pending reads of one screen, framework-free so the rules can be tested without a DOM:
 *
 * - a new Deck reads at once (when visible) and drops any answer for the previous one; new pins for the same Deck
 *   (an edited Deck List, a Swap, a Move, a changed counting setting) read again and keep the answer meanwhile;
 * - a return (focus or visibility) reads once per leave (blur or hidden): the focus and visibility notifications of
 *   one return read once, and every later return reads, however soon after the last read;
 * - a signal or retry always reads, aborting the read in flight, since it may follow a change that read missed;
 * - nothing is read while the page is hidden; a trigger then waits for the page to become visible;
 * - each read carries a generation, and an answer from an older generation, Deck or a disposed reader is dropped;
 * - a failed read keeps the last answer for the same Deck, marked stale, or reports `failed`; it never shows 0.
 *
 * There is no timer: freshness comes from the triggers alone (see the design's foreground limitation).
 */
export function createPendingReader(
  options: PendingReaderOptions
): PendingReader {
  let deck: string | null = null;
  let pins = "";
  let state: PendingState = { kind: "idle" };
  let generation = 0;
  let controller: AbortController | null = null;
  let away = false;
  let due = false;
  let disposed = false;

  const set = (next: PendingState) => {
    state = next;
    options.onState(next);
  };

  const read = () => {
    if (disposed || deck === null) return;
    if (!options.visible()) {
      due = true;
      return;
    }
    due = false;
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    const asked = ++generation;
    const deckId = deck;
    options.read(deckId, mine.signal).then(
      (answer) => {
        if (disposed || asked !== generation || answer.deck_id !== deckId)
          return;
        controller = null;
        set({
          kind: "ready",
          deckId,
          lines: new Map(answer.lines.map((line) => [line.edition_id, line])),
          stale: false,
        });
      },
      () => {
        if (disposed || asked !== generation || mine.signal.aborted) return;
        controller = null;
        set(
          state.kind === "ready" && state.deckId === deckId
            ? { ...state, stale: true }
            : { kind: "failed", deckId }
        );
      }
    );
  };

  return {
    setScope(next, nextPins) {
      if (disposed) return;
      if (next === deck) {
        if (nextPins === pins) return;
        pins = nextPins;
        read();
        return;
      }
      deck = next;
      pins = nextPins;
      generation++;
      controller?.abort();
      controller = null;
      set(next === null ? { kind: "idle" } : { kind: "loading", deckId: next });
      read();
    },
    trigger(why) {
      if (disposed || deck === null) return;
      if (why === "return") {
        // The second notification of one return (focus and visibility both fire) finds nothing left to do.
        if (!away && !due) return;
        away = false;
      }
      read();
    },
    leave() {
      away = true;
    },
    dispose() {
      disposed = true;
      generation++;
      controller?.abort();
      controller = null;
    },
  };
}

/** The line's pending note, e.g. "Misty W. agreed to lend 1 · Asked Brock S. for 2", or "" when nothing waits. */
export function pendingText(line: PendingLine | undefined): string {
  if (!line) return "";
  return line.lenders
    .map((who) =>
      who.state === "accepted"
        ? `${who.lender} agreed to lend ${who.copies}`
        : `Asked ${who.lender} for ${who.copies}`
    )
    .join(" · ");
}
