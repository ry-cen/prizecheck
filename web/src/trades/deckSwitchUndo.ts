import { announceDeckListChanged } from "../decks/deckListChanged";
import { changeDeckList, DeckError } from "../decks_generated";
import type { DeckSwitchOffer, SwitchedDeck } from "../trades_generated";
import type { useToast } from "../ui/Toast";
import { switchUndoLabel, switchUndoneText } from "./tradeText";

/**
 * The success toast of a Confirm swap that switched Decks (Trading #279), with **Undo switch** when a Deck changed.
 * Undo sends each switched Deck's inverse batch to the Deck List changes route at the revision the switch produced, in
 * the answer's order, so it is refused (STALE_DECK_LIST) once that Deck's list moved since. Like `offerReplaceUndo`, a
 * module-level function: the toast and its Undo outlive the Trade screen, and each Deck's builder is told to read again
 * after its batch landed. `sent`: the offers the collector left ticked, which name the Decks and cards in the texts.
 */
export function offerSwitchUndo(
  toast: ReturnType<typeof useToast>,
  message: string,
  sent: DeckSwitchOffer[],
  switched: SwitchedDeck[]
): void {
  if (switched.length === 0) {
    toast.show({ message });
    return;
  }
  // One key per batch, fixed now, so pressing Undo again after no answer applies each batch once.
  const jobs = switched.map((deck) => ({
    deckId: deck.deck_id,
    revision: deck.revision,
    changes: deck.undo,
    key: crypto.randomUUID(),
  }));
  const offer = (text: string) => ({
    message: text,
    action: {
      label: switchUndoLabel(sent),
      keepOpen: true,
      onAction: () => void undo(),
    },
  });
  const id = toast.show(offer(message));
  async function undo() {
    toast.update(id, {
      message,
      action: {
        label: switchUndoLabel(sent),
        keepOpen: true,
        busy: true,
        onAction: () => undefined,
      },
    });
    for (const job of jobs) {
      try {
        await changeDeckList(job.deckId, {
          revision: job.revision,
          idempotency_key: job.key,
          changes: job.changes,
        });
      } catch (cause) {
        if (cause instanceof DeckError && cause.status < 500) {
          const deck = sent.find((offer) => offer.deck_id === job.deckId);
          toast.update(id, {
            message:
              cause.code === "STALE_DECK_LIST"
                ? `Can't undo: ${deck?.deck_name ?? "a Deck"} changed.`
                : "That Undo is no longer available.",
          });
        } else
          toast.update(
            id,
            offer("Undo may not have finished. Try again to check safely.")
          );
        return;
      }
      announceDeckListChanged(job.deckId);
    }
    toast.update(id, { message: switchUndoneText(sent) });
  }
}
