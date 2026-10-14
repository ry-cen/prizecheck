import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  DeckError,
  deleteDeck,
  type DeleteDeckResult,
  type TreeNode,
} from "../decks_generated";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { TextField } from "../ui/TextField";

type Props = {
  open: boolean;
  onClose: () => void;
  returnFocus: React.RefObject<HTMLElement | null>;
  /** The Deck as last read: its name (which must be typed) and its version (which the delete checks). */
  deck: TreeNode;
  /** The copies the Deck holds (`checks.total`), which go to Unsorted. */
  copies: string;
  onDeleted: (result: DeleteDeckResult) => void;
  /** The Deck changed or is gone: the page reads it again. */
  onChanged: () => void;
};

const plural = (count: string) =>
  `${count} ${count === "1" ? "card" : "cards"}`;

/**
 * Delete a Deck (#181) through the existing route (DELETE /api/decks/{id}, Deck Lists 10): it asks for the Deck's name
 * to be typed, says the cards go to Unsorted and its Deck List is discarded, and says a Published Deck made from it stays
 * live. The name is matched as the server matches it (surrounding spaces ignored, case kept). A request with no answer
 * keeps its idempotency key, so pressing Delete again applies it once.
 */
export function DeleteDeckDialog({
  open,
  onClose,
  returnFocus,
  deck,
  copies,
  onDeleted,
  onChanged,
}: Props) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<{ name: string; version: number; key: string } | null>(
    null
  );

  useEffect(() => {
    if (!open) return;
    setTyped("");
    setError("");
    pending.current = null;
  }, [open]);

  const matches = typed.trim() === deck.name;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!matches || busy) return;
    const previous = pending.current;
    const attempt =
      previous &&
      previous.name === deck.name &&
      previous.version === deck.version
        ? previous
        : { name: deck.name, version: deck.version, key: crypto.randomUUID() };
    pending.current = attempt;
    setBusy(true);
    setError("");
    try {
      const result = await deleteDeck(deck.id, {
        name: attempt.name,
        version: attempt.version,
        idempotency_key: attempt.key,
      });
      pending.current = null;
      onDeleted(result);
    } catch (cause) {
      if (!(cause instanceof DeckError) || cause.status >= 500) {
        setError(
          "The Deck may not have been deleted. Press Delete Deck again to check safely."
        );
        return;
      }
      pending.current = null;
      if (cause.code === "STALE_LOCATION") {
        setError(
          "This Deck changed somewhere else, so nothing was deleted. It's up to date now: check its name and try again."
        );
        onChanged();
      } else if (cause.code === "LOCATION_NAME_CONFIRMATION_MISMATCH") {
        setError(
          "The name doesn't match this Deck's name any more, so nothing was deleted."
        );
        onChanged();
      } else if (cause.code === "UNSORTED_UNAVAILABLE")
        setError(
          "Nothing was deleted: your top-level Unsorted can't hold cards. Make it a Storage Leaf in Collection, then try again."
        );
      else if (cause.code === "QUANTITY_OVERFLOW")
        setError(
          "Nothing was deleted: Unsorted would hold more copies of a card than PrizeCheck allows. Move some out of Unsorted first."
        );
      else if (cause.status === 404) onChanged();
      else setError("Nothing was deleted. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Delete Deck"
      closeLabel="Close Delete Deck"
      returnFocus={returnFocus}
      bodyClassName="flex flex-col gap-3"
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <p className="m-0 text-body wrap-anywhere">
          Deleting <strong className="font-semibold">{deck.name}</strong>{" "}
          {copies === "0"
            ? "discards its Deck List. It holds no cards."
            : `moves its ${plural(copies)} to Unsorted and discards its Deck List. No card leaves your collection.`}
        </p>
        <p className="m-0 text-body text-text-muted">
          Any Published Deck made from it stays live until you revoke it on the
          Decks page.
        </p>
        <TextField
          label="Type the Deck name to confirm"
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
        {error && (
          <p role="alert" className="m-0 text-body text-warning">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="danger"
            disabled={!matches}
            aria-disabled={busy || undefined}
          >
            Delete Deck
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
