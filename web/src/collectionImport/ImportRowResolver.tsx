import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { browseEditions } from "../catalog_browse_generated";
import type {
  CollectionImportPick,
  CollectionImportRow,
} from "../collection_import_generated";
import { ROW } from "../decks/import/LineResolver";
import { Button } from "../ui/Button";
import { TextField } from "../ui/TextField";
import { useDebouncedValue } from "../workspace/useDebouncedValue";
import {
  cardText,
  otherCandidates,
  searchStart,
  UNREADABLE_QUANTITY,
} from "./importText";

type Result = {
  printing_id: string;
  name: string;
  set_name: string;
  collector_number: string;
};
type Found = {
  status: "searching" | "done" | "failed";
  rows: Result[];
};

const RESULTS = 8;

type Props = {
  row: CollectionImportRow;
  /** The panel's accessible name: "Fix row 3" or "Change card of row 3". */
  label: string;
  /** The card the collector chose, and how the notice names it. */
  onPick: (pick: CollectionImportPick, card: string) => void;
  onSkip: () => void;
  /** Escape: close the panel; focus goes back to the button that opened it. */
  onClose: () => void;
};

/**
 * Collection Import's inline resolver under a row (#229): the cards the row could be (Pick one, or a Basic Energy's
 * other Printings), a catalog search that starts on the row's card name and follows typing, and Skip row. A pick is a
 * Printing: the row's own finish then chooses its Edition, or the row asks for its finish. A row whose quantity can't
 * be read can't take a card, so it only offers Skip row. Focus starts in the search field (Skip row for such a row);
 * Escape closes the panel.
 */
export function ImportRowResolver({
  row,
  label,
  onPick,
  onSkip,
  onClose,
}: Props) {
  const field = useRef<HTMLInputElement>(null);
  const skip = useRef<HTMLButtonElement>(null);
  const readable = row.quantity !== null;
  const [query, setQuery] = useState(() => searchStart(row));
  const q = useDebouncedValue(query.trim(), 250);
  const [found, setFound] = useState<Found>({ status: "done", rows: [] });
  const candidates = otherCandidates(row);

  useEffect(() => {
    (readable ? field.current : skip.current)?.focus();
  }, [readable]);

  useEffect(() => {
    if (!readable || !q) {
      setFound({ status: "done", rows: [] });
      return;
    }
    const controller = new AbortController();
    setFound((previous) => ({ status: "searching", rows: previous.rows }));
    browseEditions({ q }, null, controller.signal)
      .then((page) => {
        const seen = new Set<string>();
        const rows: Result[] = [];
        for (const edition of page.editions) {
          if (seen.has(edition.printing_id)) continue;
          seen.add(edition.printing_id);
          rows.push(edition);
        }
        setFound({ status: "done", rows: rows.slice(0, RESULTS) });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setFound({ status: "failed", rows: [] });
      });
    return () => controller.abort();
  }, [q, readable]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onClose();
  }

  return (
    <div
      role="group"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-2 rounded-panel border border-border-strong bg-surface p-3"
    >
      {!readable && <p className="m-0 text-meta">{UNREADABLE_QUANTITY}</p>}
      {readable && candidates.length > 0 && (
        <>
          <p className="m-0 text-meta">Cards this row could be:</p>
          <ul
            aria-label="Cards this row could be"
            className="m-0 flex list-none flex-col gap-1 p-0"
          >
            {candidates.map((card) => (
              <li key={card.printing_id}>
                <button
                  type="button"
                  className={ROW}
                  onClick={() =>
                    onPick({ printing_id: card.printing_id }, cardText(card))
                  }
                >
                  {cardText(card)}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {readable && (
        <>
          <TextField
            ref={field}
            label="Search the catalog"
            type="search"
            placeholder="Name, or set code and number"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {found.rows.length > 0 && (
            <ul
              aria-label="Catalog results"
              className="m-0 flex list-none flex-col gap-1 p-0"
            >
              {found.rows.map((card) => (
                <li key={card.printing_id}>
                  <button
                    type="button"
                    className={ROW}
                    onClick={() =>
                      onPick({ printing_id: card.printing_id }, cardText(card))
                    }
                  >
                    {cardText(card)}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p role="status" className="m-0 text-meta text-text-muted">
            {found.status === "searching"
              ? "Searching…"
              : found.status === "failed"
                ? "Search isn't available right now."
                : found.rows.length === 0 && q
                  ? "No matches."
                  : ""}
          </p>
        </>
      )}
      {!row.skipped && (
        <Button
          ref={skip}
          className="self-start phone:self-stretch"
          onClick={onSkip}
        >
          Skip row
        </Button>
      )}
    </div>
  );
}
