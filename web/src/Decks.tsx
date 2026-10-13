import { useEffect, useLayoutEffect, useState, type FormEvent } from "react";
import {
  createDeck,
  getDecks,
  DeckError,
  type TreeNode,
} from "./decks_generated";
import { workspaceHref } from "./workspace/workspaceLink";

/** The Decks index (/decks), still the old page: create a Deck and list every Deck. Opening one shows the deck
 * builder at /decks/<id> (#176). #181 moves this onto the kit. */
export function Decks({ onOpenDeck }: { onOpenDeck: (id: string) => void }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [decks, setDecks] = useState<TreeNode[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<{ name: string; key: string } | null>(
    null
  );

  // Back from a Deck's builder (/decks/<id>), the index starts at the top: the shell keeps one page's scroll position
  // across its own addresses.
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  async function loadIndex() {
    const index = await getDecks();
    setDecks(index.decks);
    setCursor(index.next_cursor);
  }
  async function moreDecks() {
    if (!cursor) return;
    try {
      const index = await getDecks(cursor);
      setDecks((previous) => [...previous, ...index.decks]);
      setCursor(index.next_cursor);
    } catch (cause) {
      if (cause instanceof DeckError && cause.code === "INVENTORY_CHANGED") {
        await loadIndex();
        setMessage("Decks changed. Showing the first page.");
      } else setMessage("Decks are temporarily unavailable. Please retry.");
    }
  }
  useEffect(() => {
    void loadIndex().catch(() =>
      setMessage("Decks are temporarily unavailable. Please retry.")
    );
  }, []);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const attempt = pending ?? { name, key: crypto.randomUUID() };
    setPending(attempt);
    try {
      const result = await createDeck({
        name: attempt.name,
        idempotency_key: attempt.key,
      });
      setPending(null);
      setName("");
      onOpenDeck(result.location.id);
    } catch (cause) {
      if (cause instanceof DeckError && cause.status < 500) {
        setPending(null);
        setMessage(
          cause.code === "LOCATION_NAME_CONFLICT"
            ? "Choose a different Deck name."
            : "Enter a valid Deck name."
        );
      } else setMessage("Creation may have completed. Retry to check safely.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Physical Decks">
      <h2>Physical Decks</h2>
      <p>
        Decks contain the cards physically stored in them. Incomplete Decks
        remain usable.
      </p>
      <form onSubmit={create}>
        <label>
          Deck name{" "}
          <input
            required
            maxLength={120}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setPending(null);
            }}
          />
        </label>
        <button disabled={busy}>Create Deck</button>
      </form>
      <nav aria-label="Deck index">
        {decks.map((deck) => (
          <span key={deck.id}>
            <button type="button" onClick={() => onOpenDeck(deck.id)}>
              {deck.name}
            </button>{" "}
            {/* The accessible name starts with the visible text and names the Deck. */}
            <a
              href={workspaceHref(deck.id)}
              aria-label={`Open in Collection: ${deck.name}`}
            >
              Open in Collection
            </a>{" "}
          </span>
        ))}
      </nav>
      {cursor && (
        <button type="button" onClick={() => void moreDecks()}>
          More Decks
        </button>
      )}
      {!decks.length && <p>No Decks yet.</p>}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
