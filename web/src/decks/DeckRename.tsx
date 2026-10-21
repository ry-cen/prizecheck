import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { DeckError, editDeck, type TreeNode } from "../decks_generated";
import { Button } from "../ui/Button";
import { TextField } from "../ui/TextField";

/**
 * Rename on the deck builder (#291): a Rename button beside the title swaps the title for a form (Enter saves,
 * Escape cancels). The rename is an ordinary edit of the Deck, checked against its version; a retry after a failed
 * request with the same name and version reuses its key. The new name shows at once and is announced.
 */
export function useDeckRename(options: {
  deckId: string;
  /** detail.deck */
  deck: TreeNode | null;
  beginCommand: () => () => void;
  onRenamed: (deck: TreeNode) => void;
  reread: () => Promise<unknown>;
  onMissing: () => void;
}): { action: ReactNode; editor: ReactNode | undefined; status: ReactNode } {
  const { deckId, deck, beginCommand, onRenamed, reread, onMissing } = options;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const renameButton = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const focusRename = useRef(false);
  const failed = useRef<{ name: string; version: number; key: string } | null>(
    null
  );
  const errorId = useId();

  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    } else if (focusRename.current) {
      focusRename.current = false;
      renameButton.current?.focus();
    }
  }, [editing]);

  function start() {
    if (!deck) return;
    setText(deck.name);
    setError("");
    setAnnouncement("");
    setEditing(true);
  }

  function cancel() {
    if (busy) return;
    failed.current = null;
    setError("");
    focusRename.current = true;
    setEditing(false);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !deck) return;
    const name = text.trim();
    if (name === "") {
      setError("Enter a name for the Deck.");
      return;
    }
    if ([...name].length > 120) {
      setError("Deck names can be up to 120 characters.");
      return;
    }
    if (name === deck.name) {
      cancel();
      return;
    }
    const retry = failed.current;
    const key =
      retry && retry.name === name && retry.version === deck.version
        ? retry.key
        : crypto.randomUUID();
    failed.current = null;
    setBusy(true);
    setError("");
    const settle = beginCommand();
    let failedAttempt = false;
    try {
      const result = await editDeck(deckId, {
        name,
        version: deck.version,
        idempotency_key: key,
      });
      onRenamed(result.location);
      setAnnouncement(`Renamed the Deck to ${result.location.name}.`);
      focusRename.current = true;
      setEditing(false);
      // A rename moves the owner revision, which Export checks: read the Deck once more so it carries the new one.
      void reread();
    } catch (cause) {
      failedAttempt = true;
      if (
        cause instanceof DeckError &&
        cause.code === "LOCATION_NAME_CONFLICT"
      ) {
        setError("That name is already taken. Choose a different Deck name.");
        settle();
      } else if (
        cause instanceof DeckError &&
        cause.code === "INVALID_LOCATION_NAME"
      ) {
        setError("That name can't be used. Choose a different Deck name.");
        settle();
      } else if (cause instanceof DeckError && cause.status === 409) {
        await reread();
        setError(
          "This Deck changed somewhere else, so it wasn't renamed. It's up to date now: try again."
        );
      } else if (cause instanceof DeckError && cause.status === 404) {
        onMissing();
      } else {
        failed.current = { name, version: deck.version, key };
        setError(
          "The Deck couldn't be renamed. Check your connection and try again."
        );
        settle();
      }
    } finally {
      setBusy(false);
    }
    if (failedAttempt) input.current?.focus();
  }

  const action = (
    <Button variant="quiet" ref={renameButton} onClick={start}>
      Rename
    </Button>
  );
  const editor = editing ? (
    <form
      aria-label="Rename Deck"
      onSubmit={(event) => void save(event)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
      className="flex min-w-0 flex-wrap items-end gap-2"
    >
      <div className="w-80 max-w-full">
        <TextField
          label="Deck name"
          ref={input}
          value={text}
          autoComplete="off"
          onChange={(event) => setText(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
      </div>
      <Button type="submit" variant="primary" aria-disabled={busy || undefined}>
        Save
      </Button>
      <Button onClick={cancel} aria-disabled={busy || undefined}>
        Cancel
      </Button>
      {error && (
        <p
          id={errorId}
          role="alert"
          className="m-0 basis-full text-body text-warning"
        >
          {error}
        </p>
      )}
    </form>
  ) : undefined;
  const status = (
    <p role="status" className="sr-only">
      {announcement}
    </p>
  );
  return { action, editor, status };
}
