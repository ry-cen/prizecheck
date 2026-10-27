import { useEffect, useRef, useState } from "react";
import {
  changeDeckList,
  DeckError,
  type DeckListChange,
} from "../decks_generated";
import { useToast } from "../ui/Toast";
import { variantLabel } from "../ui/variantLabel";
import type {
  SwapHint,
  WantList,
  WantListLine,
  WantListSection,
} from "../want_list_generated";
import type { WillAcceptRule } from "./tradeWantsModel";

/** The owned Edition a hint names, as the hint reads it: "PAL 254", or "PAL 254 Reverse Holo" for any variant but
 * Normal. */
export function swapVersion(hint: SwapHint): string {
  const variant = variantLabel(hint.descriptor);
  return `${hint.set_code} ${hint.collector_number}${variant === "Normal" ? "" : ` ${variant}`}`;
}

/** "You own a playable version (PAL 254) × 1" (spec user story 80); the hint draws "↻" before it, hidden from readers.
 * A line whose Will accept choice is any card with the same name (Trading #275) says "You own a card with the same name
 * (SVE 005) × 1" instead, because a card with the same name can play differently. */
export function swapHintText(hint: SwapHint, rule?: WillAcceptRule): string {
  const what =
    rule === "identity" ? "a card with the same name" : "a playable version";
  return `You own ${what} (${swapVersion(hint)}) × ${hint.count}`;
}

/** The Swap button's accessible name: it starts with the button's text and names the line's own version and the owned
 * Edition, for example "Swap 1 Iono Paldea Evolved 185 for PAL 254", so two Swap buttons in one Deck never share a name. */
export function swapLabel(line: WantListLine, hint: SwapHint): string {
  const variant = variantLabel(line.descriptor);
  const own = `${line.set_name} ${line.collector_number}${variant === "Normal" ? "" : ` ${variant}`}`;
  return `Swap ${hint.count} ${line.name} ${own} for ${swapVersion(hint)}`;
}

/** Swap's batch: the line lowered by the hint's count (0 removes it) and the owned Edition's line raised by as many
 * (from 0 adds it); and the inverse batch that Undo sends. Totals, as the batch route takes them. */
export function swapChanges(
  line: WantListLine,
  hint: SwapHint
): { changes: DeckListChange[]; inverse: DeckListChange[] } {
  const count = BigInt(hint.count);
  const quantity = BigInt(line.quantity);
  const listed = BigInt(hint.listed);
  return {
    changes: [
      { edition_id: line.edition_id, quantity: (quantity - count).toString() },
      { edition_id: hint.edition_id, quantity: (listed + count).toString() },
    ],
    inverse: [
      { edition_id: line.edition_id, quantity: line.quantity },
      { edition_id: hint.edition_id, quantity: hint.listed },
    ],
  };
}

type UndoJob = {
  deckId: string;
  message: string;
  changes: DeckListChange[];
  /** The revision the Swap answered: the inverse is refused (STALE_DECK_LIST) if the list moved since. */
  revision: number;
  key: string;
};

export type WantListSwap = {
  /** A Swap or its Undo is on its way: every Swap button ignores presses until it lands. */
  busy: boolean;
  swap: (section: WantListSection, line: WantListLine) => void;
};

type Options = {
  /** The Want List the page shows now (null while it has none): a new answer ends the wait that follows a command. */
  list: WantList | null;
  /** Whether the page's last read failed: that also ends the wait. */
  failed: boolean;
  /** Read the Want List again: every count follows a Swap, its Undo or a refusal. */
  reload: () => void;
  /** Say something on the page's status line (a Swap that wasn't made). */
  notify: (text: string) => void;
};

/**
 * Swap from the Want List (decklist import #211). Swap sends one existing Deck List changes batch
 * (POST /api/decks/{id}/deck-list/changes) at the section's Deck List revision, lowering the line and raising or adding
 * the owned Edition's line; the toast's Undo sends the inverse batch at the revision the Swap answered, as the deck
 * builder's Undo does (useDeckListEdits). One command at a time.
 *
 * - **STALE_DECK_LIST on Swap:** the Deck List changed after the page read it. Nothing was swapped; the page reads the
 *   Want List again and says so. It is not sent again: the fresh read may offer something else.
 * - **STALE_DECK_LIST on Undo:** "Can't undo: this deck changed.", and the page reads again.
 * - **No answer or a 5xx:** the outcome is unknown, so the page reads again (a Swap that landed shows as made). A Swap
 *   offers no Undo then; an Undo can be pressed again, with the same key, so it applies once.
 *
 * The toast takes the focus: the line's Swap button leaves the page once the Want List is read again. Leaving the
 * Want List takes the toast down.
 */
export function useWantListSwap({
  list,
  failed,
  reload,
  notify,
}: Options): WantListSwap {
  const kit = useToast();
  const live = useRef({ reload, notify });
  live.current = { reload, notify };
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  // A command landed and the page is reading the Want List again: the buttons stay off until the new answer draws.
  const pending = useRef(false);
  const toastId = useRef<number | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (toastId.current !== null) kit.dismiss(toastId.current);
    };
  }, [kit]);

  // The new answer (or a failed read) ends the wait.
  useEffect(() => {
    if (!pending.current) return;
    pending.current = false;
    working.current = false;
    setBusy(false);
  }, [list, failed]);

  function start(): boolean {
    if (working.current) return false;
    working.current = true;
    setBusy(true);
    return true;
  }

  function finish() {
    if (!mounted.current) return;
    pending.current = true;
    live.current.reload();
  }

  function say(message: string, job: UndoJob | null, busyUndo = false) {
    if (!mounted.current) return;
    const input = {
      message,
      focus: true,
      action: job
        ? {
            label: "Undo",
            keepOpen: true,
            busy: busyUndo,
            onAction: () => void undo(job),
          }
        : undefined,
    };
    if (busyUndo && toastId.current !== null)
      kit.update(toastId.current, input);
    else toastId.current = kit.show(input);
  }

  async function swap(section: WantListSection, line: WantListLine) {
    const hint = line.swap;
    if (!hint || !start()) return;
    live.current.notify("");
    const { changes, inverse } = swapChanges(line, hint);
    const message = `Swapped ${hint.count} ${line.name} for ${swapVersion(hint)} in ${section.name}.`;
    try {
      const result = await changeDeckList(section.deck_id, {
        revision: section.deck_list_revision,
        idempotency_key: crypto.randomUUID(),
        changes,
      });
      say(message, {
        deckId: section.deck_id,
        message,
        changes: inverse,
        revision: result.deck_list.revision,
        key: crypto.randomUUID(),
      });
    } catch (cause) {
      if (mounted.current)
        live.current.notify(
          !(cause instanceof DeckError) || cause.status >= 500
            ? "Your swap may not have been saved. The Want List is up to date now: check the line and try again."
            : cause.code === "STALE_DECK_LIST"
              ? `${section.name} changed somewhere else, so nothing was swapped. The Want List is up to date now.`
              : cause.code === "EDITION_UNAVAILABLE"
                ? "That card can't be added any more, so the Deck List wasn't changed."
                : "The Deck List couldn't be changed. Try again."
        );
    } finally {
      finish();
    }
  }

  async function undo(job: UndoJob) {
    if (!start()) return;
    say(job.message, job, true);
    try {
      await changeDeckList(job.deckId, {
        revision: job.revision,
        idempotency_key: job.key,
        changes: job.changes,
      });
      say(`Undone: ${job.message}`, null);
    } catch (cause) {
      if (!(cause instanceof DeckError) || cause.status >= 500)
        // No answer: the same key makes pressing Undo again apply it once.
        say("Undo may not have finished. Try again to check safely.", job);
      else
        say(
          cause.code === "STALE_DECK_LIST"
            ? "Can't undo: this deck changed."
            : "That Undo is no longer available.",
          null
        );
    } finally {
      finish();
    }
  }

  return { busy, swap: (section, line) => void swap(section, line) };
}
