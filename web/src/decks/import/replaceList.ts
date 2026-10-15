import {
  changeDeckList,
  DeckError,
  type DeckListChange,
  type DeckListCommandResult,
  type ImportReplace,
} from "../../decks_generated";
import type { useToast } from "../../ui/Toast";
import { announceDeckListChanged } from "../deckListChanged";
import { plural } from "./importModel";

/**
 * Replace list… (#215): the deck builder's way into the import, which pastes a new list over the Deck's Deck List.
 * The review (POST /api/decks/import/review with the Deck's id) answers `replace`: the Deck List revision, the current
 * lines, the changes batch and the Surplus preview. Saving sends that batch through the Deck List changes route at
 * that revision; Undo is the inverse batch. Nothing moves: the copies the new list doesn't cover stay in the Deck as
 * Surplus.
 */

/** The Deck whose Deck List the paste replaces. */
export type ReplaceTarget = { deckId: string; name: string };

/** The most changes one Deck List batch takes (the API's MAX_DECK_LIST_CHANGES): new lines plus removed lines. */
export const MAX_DECK_LIST_CHANGES = 200;

/** /decks/<id>/replace: the Replace list… screen for that Deck. */
export const replacePath = (deckId: string) =>
  `/decks/${encodeURIComponent(deckId)}/replace`;

/** The Deck id in "<id>/replace" (the decks page's sectionAt), else null. */
export function replacedDeckAt(section: string | null): string | null {
  const match = /^([^/]+)\/replace$/.exec(section ?? "");
  return match ? match[1] : null;
}

/** True when saving would send more changes than one batch takes. */
export const tooManyChanges = (replace: ImportReplace) =>
  replace.changes.length > MAX_DECK_LIST_CHANGES;

/** Why Replace Deck List is unavailable when the batch is over the cap. */
export const tooManyText = (replace: ImportReplace) =>
  `This replaces ${replace.changes.length} Deck List lines; one save changes at most ${MAX_DECK_LIST_CHANGES}.`;

/** What a save answered STALE_DECK_LIST says, above the review it posted again. */
export const STALE_REPLACE_TEXT =
  "This Deck's list changed after you checked it. The review is up to date now: check it and save again.";

/** The inverse batch: every Edition the save changed, back to its quantity before (0 when it wasn't listed). */
export function undoChanges(replace: ImportReplace): DeckListChange[] {
  const before = new Map(
    replace.current.map((line) => [line.edition_id, line.quantity])
  );
  return replace.changes.map((change) => ({
    edition_id: change.edition_id,
    quantity: before.get(change.edition_id) ?? "0",
  }));
}

/** Copies the preview says become Surplus. */
export const surplusCopies = (replace: ImportReplace) =>
  replace.surplus.reduce((sum, row) => sum + BigInt(row.quantity), 0n);

/** The toast after saving: "Replaced Gardevoir ex's Deck List. 3 cards became Surplus." */
export function replacedText(replace: ImportReplace): string {
  const copies = surplusCopies(replace);
  return `Replaced ${replace.name}'s Deck List.${
    copies > 0n ? ` ${plural(Number(copies), "card")} became Surplus.` : ""
  }`;
}

/**
 * Offers Undo for a Replace just saved: the inverse batch at the revision the save answered, so it is refused
 * (STALE_DECK_LIST) if the Deck List moved since. A module-level function, so the toast and its Undo outlive the import
 * page; after Undo lands, the Deck's builder is told to read again. The wording on refusal is the builder's own.
 */
export function offerReplaceUndo(
  toast: ReturnType<typeof useToast>,
  replace: ImportReplace,
  result: DeckListCommandResult
) {
  const key = crypto.randomUUID();
  const changes = undoChanges(replace);
  const message = replacedText(replace);
  const offer = (text: string) => ({
    message: text,
    action: { label: "Undo", keepOpen: true, onAction: () => void undo() },
  });
  const id = toast.show(offer(message));
  async function undo() {
    toast.update(id, {
      message,
      action: {
        label: "Undo",
        keepOpen: true,
        busy: true,
        onAction: () => undefined,
      },
    });
    try {
      await changeDeckList(replace.deck_id, {
        revision: result.deck_list.revision,
        idempotency_key: key,
        changes,
      });
    } catch (cause) {
      if (cause instanceof DeckError && cause.status < 500)
        toast.update(id, {
          message:
            cause.code === "STALE_DECK_LIST"
              ? "Can't undo: this deck changed."
              : "That Undo is no longer available.",
        });
      // No answer: the same key makes pressing Undo again apply it once.
      else
        toast.update(
          id,
          offer("Undo may not have finished. Try again to check safely.")
        );
      return;
    }
    announceDeckListChanged(replace.deck_id);
    toast.update(id, { message: "Deck List restored." });
  }
}
