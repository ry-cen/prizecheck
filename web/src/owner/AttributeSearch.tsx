import { useRef, useState } from "react";
import { searchCatalog, type PrintingView } from "../generated";
import {
  getAttributeEvidence,
  type AttributeEvidence,
} from "../metadata_generated";
import { Button } from "../ui/Button";
import { SearchField } from "../ui/SearchField";
import { Select } from "../ui/Select";
import { AttributeReviewCard } from "./AttributeReviewCard";
import { CARD_HEADING } from "./ReviewQueue";

type Props = {
  /** The Printing ids in the queue. A found Printing that is listed opens in its queue row instead. */
  queued: (printingId: string) => boolean;
  onOpenQueued: (printingId: string) => void;
  /** A decision was recorded on a card opened here. */
  onDone: (message: string) => void;
};

const label = (printing: PrintingView) =>
  `${printing.name} · ${printing.set_id} · ${printing.collector_number}`;

/**
 * Review any card (#191), above the Attributes queue: find a Printing by name through the catalog search and
 * open it in the same review card a queued Printing gets, so a card nobody reported can be reviewed on the
 * owner's own initiative, with the same reason and evidence rules. A Printing that is already in the queue
 * opens in its queue row.
 */
export function AttributeSearch({ queued, onOpenQueued, onDone }: Props) {
  const searchField = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<PrintingView[] | null>(null);
  const [more, setMore] = useState(false);
  const [chosen, setChosen] = useState("");
  const [picked, setPicked] = useState<AttributeEvidence | null>(null);
  const [error, setError] = useState("");

  function focusSearch() {
    searchField.current?.querySelector("input")?.focus();
  }

  async function find() {
    if (!query.trim()) return;
    setError("");
    try {
      const page = await searchCatalog({ name: query.trim() });
      setFound(page.printings);
      setMore(!!page.next_cursor);
      setChosen("");
    } catch {
      setError("Unable to search the catalog. Please retry.");
    }
  }

  async function review() {
    if (!chosen) return;
    setError("");
    if (queued(chosen)) {
      setPicked(null);
      onOpenQueued(chosen);
      return;
    }
    try {
      setPicked(await getAttributeEvidence(chosen));
    } catch {
      setError("Unable to load that card. Please retry.");
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <h3 className={CARD_HEADING}>Review any card</h3>
      <div className="flex flex-wrap items-end gap-2">
        <div ref={searchField} className="min-w-0 grow basis-60">
          <SearchField
            label="Find a card to review"
            placeholder="Card name"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void find();
            }}
          />
        </div>
        <Button disabled={!query.trim()} onClick={() => void find()}>
          Find
        </Button>
      </div>
      {found &&
        (found.length ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 grow basis-60">
              <Select
                label="Printing to review"
                value={chosen}
                onChange={(event) => setChosen(event.target.value)}
              >
                <option value="">Choose a Printing</option>
                {found.map((printing) => (
                  <option key={printing.id} value={printing.id}>
                    {label(printing)}
                  </option>
                ))}
              </Select>
            </div>
            <Button disabled={!chosen} onClick={() => void review()}>
              Review card
            </Button>
          </div>
        ) : (
          <p className="m-0 text-meta text-text-muted">
            No card has a name that starts that way.
          </p>
        ))}
      {found && more && (
        <p className="m-0 text-meta text-text-muted">
          More cards match. Type more of the name to narrow the list.
        </p>
      )}
      {error && (
        <p role="alert" className="m-0 text-meta text-danger">
          {error}
        </p>
      )}
      {picked && (
        <div className="box-border min-w-0 rounded-panel border border-border bg-surface-raised p-4 phone:p-3">
          <AttributeReviewCard
            key={picked.printing_id}
            item={picked}
            onClose={() => {
              setPicked(null);
              focusSearch();
            }}
            onDone={(message, removed) => {
              onDone(message);
              if (removed) {
                setPicked(null);
                focusSearch();
              }
            }}
          />
        </div>
      )}
    </div>
  );
}
