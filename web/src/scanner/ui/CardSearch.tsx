import { useEffect, useState } from "react";
import {
  browseEditions,
  type BrowseEdition,
} from "../../catalog_browse_generated";
import { Button } from "../../ui/Button";
import { CONTROL_BOX } from "../../ui/control";
import { Dialog } from "../../ui/Dialog";
import { variantLabel } from "../../ui/variantLabel";
import { useDebouncedValue } from "../../workspace/useDebouncedValue";
import { CardArt } from "./CardArt";
import {
  BACK_TO_SCANNING,
  NO_MATCHES,
  SEARCH_FIELD,
  SEARCHING,
  SEARCH_PLACEHOLDER,
  SEARCH_UNAVAILABLE,
} from "./copy";

const RESULTS = 12;

type Found = {
  status: "idle" | "searching" | "done" | "failed";
  rows: BrowseEdition[];
};

export type SearchPick = { printingId: string; editionId: string };

/**
 * Catalog search in a dialog, for a missed card, a row's Change card and the cannot-start screen. A result is one Card
 * Edition, so a tap picks the card and its finish together (a search pick takes the Edition the collector chose, never
 * the starting one). The field is 16 px on a phone, so iOS does not zoom the page when it takes focus.
 */
export function CardSearch({
  title,
  intro,
  closeLabel = BACK_TO_SCANNING,
  notice,
  onPick,
  onClose,
  returnFocus,
}: {
  title: string;
  intro?: string;
  closeLabel?: string;
  /** A refusal of the last pick (a full tray), shown under the results. */
  notice?: string | null;
  onPick: (pick: SearchPick) => void;
  onClose: () => void;
  returnFocus?: React.RefObject<HTMLElement | null>;
}) {
  const [query, setQuery] = useState("");
  const q = useDebouncedValue(query.trim(), 250);
  const [found, setFound] = useState<Found>({ status: "idle", rows: [] });

  useEffect(() => {
    if (!q) {
      setFound({ status: "idle", rows: [] });
      return;
    }
    const controller = new AbortController();
    setFound((previous) => ({ status: "searching", rows: previous.rows }));
    browseEditions({ q }, null, controller.signal)
      .then((page) =>
        setFound(
          page.available
            ? { status: "done", rows: page.editions.slice(0, RESULTS) }
            : { status: "failed", rows: [] }
        )
      )
      .catch(() => {
        if (!controller.signal.aborted)
          setFound({ status: "failed", rows: [] });
      });
    return () => controller.abort();
  }, [q]);

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      closeLabel={`Close ${title}`}
      size="wide"
      returnFocus={returnFocus}
    >
      <div className="flex flex-col gap-3 p-4">
        {intro && <p className="m-0 text-body text-text-muted">{intro}</p>}
        <input
          type="search"
          data-autofocus
          aria-label={SEARCH_FIELD}
          placeholder={SEARCH_PLACEHOLDER}
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className={`${CONTROL_BOX} h-control phone:h-control-phone phone:text-[16px]`}
        />
        {found.rows.length > 0 && (
          <ul
            aria-label="Catalog results"
            className="m-0 flex list-none flex-col gap-1 p-0"
          >
            {found.rows.map((card) => (
              <li key={card.edition_id}>
                <button
                  type="button"
                  onClick={() =>
                    onPick({
                      printingId: card.printing_id,
                      editionId: card.edition_id,
                    })
                  }
                  className="box-border flex min-h-control w-full cursor-pointer items-center gap-3 rounded-control border border-border-strong bg-surface-raised p-2 text-left font-sans text-control text-text hover:border-control-outline phone:min-h-tap"
                >
                  <CardArt src={card.image_url} size="sm" />
                  <span className="flex min-w-0 flex-col">
                    <span className="font-semibold">{card.name}</span>
                    <span className="text-meta text-text-muted">
                      {card.set_name} {card.collector_number} ·{" "}
                      {variantLabel(card.descriptor)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p role="status" className="m-0 text-meta text-text-muted">
          {found.status === "searching"
            ? SEARCHING
            : found.status === "failed"
              ? SEARCH_UNAVAILABLE
              : found.status === "done" && found.rows.length === 0
                ? NO_MATCHES
                : ""}
        </p>
        {notice && (
          <p role="alert" className="m-0 text-meta text-warning">
            {notice}
          </p>
        )}
        <Button
          variant="quiet"
          className="self-start phone:self-stretch"
          onClick={onClose}
        >
          {closeLabel}
        </Button>
      </div>
    </Dialog>
  );
}
