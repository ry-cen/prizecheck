import { useEffect, useRef, useState } from "react";
import { browseEditions } from "../../catalog_browse_generated";
import type { ReviewLine } from "../../decks_generated";
import { Button } from "../../ui/Button";
import { TextField } from "../../ui/TextField";
import { missingCardHref } from "../../reports/missingCardLink";
import { useDebouncedValue } from "../../workspace/useDebouncedValue";
import { printingText, searchStart, type Pick } from "./importModel";

/** A choice button inside a resolver: 30 px tall on desktop, 44 px on a phone. */
export const ROW =
  "box-border flex min-h-control w-full cursor-pointer items-center rounded-control border border-border bg-bg px-2 py-1 text-left font-sans text-control text-text wrap-anywhere hover:bg-surface-raised phone:min-h-tap";

type Row = {
  printing_id: string;
  name: string;
  set_code: string;
  collector_number: string;
};
type Found =
  | { status: "searching"; rows: Row[] }
  | { status: "done"; rows: Row[] }
  | { status: "failed"; rows: Row[] };

const RESULTS = 8;

/**
 * The inline resolver under a flagged line (#212, #213): the cards the line could mean (Pick one: one per code and
 * number, or one per Reprint Group of its name), a catalog search that starts on the pasted name and follows typing,
 * Drop line, and for a Not found line the link that reports it on Missing cards with the form filled in. The link opens
 * a new tab, so the review stays as it is. A pick is any Edition of the card by the add-by-Printing rule; the Edition
 * chooser changes it afterwards.
 */
export function LineResolver({
  line,
  onPick,
  onDrop,
}: {
  line: ReviewLine;
  onPick: (pick: Pick) => void;
  onDrop: () => void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(searchStart(line));
  const q = useDebouncedValue(query.trim(), 250);
  const [found, setFound] = useState<Found>({ status: "searching", rows: [] });

  useEffect(() => {
    field.current?.focus();
  }, []);

  useEffect(() => {
    if (!q) {
      setFound({ status: "done", rows: [] });
      return;
    }
    const controller = new AbortController();
    setFound((previous) => ({ status: "searching", rows: previous.rows }));
    browseEditions({ q }, null, controller.signal)
      .then((page) => {
        const seen = new Set<string>();
        const rows: Row[] = [];
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
  }, [q]);

  return (
    <div
      role="group"
      aria-label={`Fix ${line.text}`}
      className="flex flex-col gap-2 rounded-panel border border-border-strong bg-surface p-3"
    >
      {line.candidates.length > 0 && (
        <>
          <p className="m-0 text-meta">Cards this line could mean:</p>
          <ul
            aria-label="Cards this line could mean"
            className="m-0 flex list-none flex-col gap-1 p-0"
          >
            {line.candidates.map((candidate) => (
              <li key={candidate.printing_id}>
                <button
                  type="button"
                  className={ROW}
                  onClick={() => onPick({ printing_id: candidate.printing_id })}
                >
                  {printingText(candidate)}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
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
          {found.rows.map((row) => (
            <li key={row.printing_id}>
              <button
                type="button"
                className={ROW}
                onClick={() => onPick({ printing_id: row.printing_id })}
              >
                {`${row.name} ${row.set_code} ${row.collector_number}`}
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
      {line.report && (
        <a
          className="inline-flex min-h-(--target-pointer) items-center self-start text-meta text-accent underline underline-offset-2 hover:text-accent-strong phone:min-h-tap"
          href={missingCardHref(line.report)}
          target="_blank"
          rel="noopener noreferrer"
        >
          Report it on Missing cards
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      )}
      <Button
        variant="danger"
        className="self-start phone:self-stretch"
        onClick={onDrop}
      >
        Drop line
      </Button>
    </div>
  );
}
