import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { CostSection } from "../DeckCost";
import { DeckCostLine } from "../decks/DeckCostLine";
import { useDeckCost } from "../decks/useDeckCost";
import { getDeck, type DeckDetail } from "../decks_generated";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";

type Props = {
  deckId: string;
  /** The gallery's owner revision. When it is newer than this Deck read, the Deck is read again. */
  inventoryRevision: number | null;
  /** Opens this Deck in the deck builder on Decks (/decks/<id>). */
  onOpenDeck: (deckId: string) => void;
};

// The existing Estimated Deck Cost section (DeckCost.tsx), styled from here so its markup stays unchanged.
const COST =
  "min-w-0 flex-[1_1_320px] text-meta text-text-muted tabular-nums [&>section]:flex [&>section]:flex-col [&>section]:gap-1 [&_h2]:m-0 [&_h2]:text-micro [&_h2]:font-semibold [&_h2]:tracking-[1.7px] [&_h2]:text-text-muted [&_h2]:uppercase [&_p]:m-0 [&_p:first-of-type]:text-body [&_p:first-of-type]:text-text [&_strong]:font-semibold [&_strong]:text-accent";

/** The open Deck's banner above its Holdings in Collection (#181): the Estimated Deck Cost of the copies it holds, the
 * Deck List cost and the cost to complete, and a link to the Deck in the deck builder. Its Holdings stay in the gallery
 * below with Move, Remove and Undo; exports live on Decks. Cost comes from the server's complete Deck read and one cost
 * read (the Deck and cost endpoints), never from the gallery's loaded tiles. */
export function DeckHeading({ deckId, inventoryRevision, onOpenDeck }: Props) {
  const [detail, setDetail] = useState<DeckDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);

  // Only the newest read may settle, and a read never steps back to an older inventory revision.
  const load = useCallback(async () => {
    const id = ++generation.current;
    try {
      const next = await getDeck(deckId);
      if (id !== generation.current) return;
      setDetail((previous) =>
        previous && previous.owner_revision > next.owner_revision
          ? previous
          : next
      );
      setFailed(false);
    } catch {
      if (id === generation.current) setFailed(true);
    }
  }, [deckId]);

  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);

  // The gallery saw a newer inventory than this Deck read: read the Deck again. An equal revision changes
  // nothing, so the cost isn't requested twice.
  const readRevision = detail?.owner_revision;
  useEffect(() => {
    if (
      inventoryRevision !== null &&
      readRevision !== undefined &&
      inventoryRevision > readRevision
    )
      void load();
  }, [inventoryRevision, readRevision, load]);

  const cost = useDeckCost(
    deckId,
    detail?.deck_list.revision ?? null,
    detail?.owner_revision ?? null,
    () => void load()
  );

  return (
    <section
      aria-label="Deck banner"
      className="mb-5 box-border flex flex-wrap items-start justify-between gap-x-6 gap-y-3 rounded-panel border border-border bg-surface p-4"
    >
      <div className={COST}>
        {detail ? (
          <CostSection
            settled={cost}
            totalCopies={detail.checks.total}
            headingLevel={2}
          />
        ) : (
          !failed && (
            <CostSection settled={null} totalCopies="0" headingLevel={2} />
          )
        )}
      </div>
      <div className="flex max-w-full flex-none flex-col items-end gap-2 phone:items-start">
        {detail && <DeckCostLine settled={cost} />}
        <a
          href={`/decks/${encodeURIComponent(deckId)}`}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey) return;
            event.preventDefault();
            onOpenDeck(deckId);
          }}
          className="inline-flex h-control items-center gap-1 rounded-control px-2 text-control font-medium text-accent-strong no-underline hover:bg-surface-raised phone:h-control-phone"
        >
          Open in the deck builder
          <Icon icon={ArrowRight} />
        </a>
      </div>
      {failed && (
        <div
          className="flex flex-[1_1_100%] items-center gap-3 text-meta text-danger"
          role="alert"
        >
          <p className="m-0">
            {detail
              ? "This Deck's details couldn't load."
              : "Deck cost is temporarily unavailable."}
          </p>
          <Button onClick={() => void load()}>Retry</Button>
        </div>
      )}
    </section>
  );
}
