import { useEffect, useState } from "react";
import { DeckError, getDeck } from "../../decks_generated";
import { PageHeader } from "../../shell/PageHeader";
import { Button } from "../../ui/Button";
import { ImportPage } from "./ImportPage";

type Load =
  | { kind: "loading" }
  | { kind: "ready"; name: string }
  | { kind: "missing" }
  | { kind: "failed" };

const LINK =
  "inline-flex h-control items-center gap-1 self-start rounded-control px-2 text-control font-medium text-accent-strong no-underline hover:bg-surface-raised phone:h-control-phone";

/**
 * Replace list… (/decks/<id>/replace, #215): reads the Deck for its name, then opens the import on it. A Deck that
 * doesn't exist (or isn't the collector's) reads "Deck not found", as the builder does.
 */
export function ReplaceListPage({
  deckId,
  onOpenDeck,
  onAllDecks,
}: {
  deckId: string;
  onOpenDeck: (id: string) => void;
  onAllDecks: () => void;
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setLoad({ kind: "loading" });
    getDeck(deckId)
      .then((detail) => {
        if (live) setLoad({ kind: "ready", name: detail.deck.name });
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setLoad(
          cause instanceof DeckError &&
            (cause.status === 404 || cause.status === 422)
            ? { kind: "missing" }
            : { kind: "failed" }
        );
      });
    return () => {
      live = false;
    };
  }, [deckId, attempt]);

  if (load.kind === "ready")
    return (
      <ImportPage
        replace={{ deckId, name: load.name }}
        onOpenDeck={onOpenDeck}
        onAllDecks={onAllDecks}
      />
    );
  return (
    <main className="mx-auto box-border flex max-w-7xl flex-col gap-4 px-7 py-6 phone:px-4 phone:py-4">
      <a
        href="/decks"
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey) return;
          event.preventDefault();
          onAllDecks();
        }}
        className={LINK}
      >
        ‹ Decks
      </a>
      {load.kind === "missing" ? (
        <>
          <PageHeader title="Deck not found" />
          <p className="m-0 text-body text-text-muted">
            This Deck doesn't exist, or it was deleted.
          </p>
        </>
      ) : load.kind === "failed" ? (
        <>
          <PageHeader title="Deck unavailable" />
          <p role="status" className="m-0 text-body text-text-muted">
            This Deck couldn't be loaded. Check your connection and try again.
          </p>
          <Button
            className="self-start"
            onClick={() => setAttempt((count) => count + 1)}
          >
            Retry
          </Button>
        </>
      ) : (
        <p role="status" className="m-0 text-body text-text-muted">
          Loading Deck…
        </p>
      )}
    </main>
  );
}
