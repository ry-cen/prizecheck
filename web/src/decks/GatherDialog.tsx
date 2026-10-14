import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { TriangleAlert } from "lucide-react";
import {
  confirmPicks,
  DeckError,
  getPickList,
  type PickConfirmResult,
  type PickList,
  type PickRow,
} from "../decks_generated";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../ui/Icon";
import { Select } from "../ui/Select";
import { editionText, type DeckLine } from "./deckListModel";
import {
  confirmItems,
  copiesText,
  defaultChoice,
  locationsText,
  offersSuggestion,
  rowCopies,
  sourceLabel,
  sourceOption,
  SUGGESTED,
  suggestionOption,
  takesFor,
  takesText,
  type GatherChoice,
} from "./gatherModel";

type Props = {
  open: boolean;
  deckId: string;
  /** The page's Deck List lines, for each card's name and Edition. */
  lines: readonly DeckLine[];
  /** The copy sheet's card: its row starts picked and takes focus. Null from Gather N. */
  focusEdition: string | null;
  returnFocus: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** A confirmation succeeded. The page closes the dialog, reads the Deck again and shows the Undo toast. */
  onConfirmed: (result: PickConfirmResult) => void;
  /** The collection changed under the dialog (a refused confirmation): the page reads the Deck again. */
  onChanged: () => void;
};

type Load =
  { kind: "loading" } | { kind: "ready"; list: PickList } | { kind: "failed" };

const CHANGED =
  "Your cards or this Deck List changed since this list was read, so nothing was moved. The list is up to date again: check it and confirm once more.";

/**
 * Gather (#179): the Pick List as a dialog, arranged by card. Each row is a Deck List line with copies owned
 * elsewhere, with a source picker (the server's suggestion or any one Location that holds the card), where its
 * copies come from, and a warning when a source is another Deck that would be left short. Confirm picked
 * confirms the ticked rows and Confirm all every row; each is one multi-source Move with one Undo record
 * (POST /api/decks/{id}/pick-list/confirm). A request with no answer keeps its idempotency key, so pressing the
 * same confirmation again applies it once.
 */
export function GatherDialog({
  open,
  deckId,
  lines,
  focusEdition,
  returnFocus,
  onClose,
  onConfirmed,
  onChanged,
}: Props) {
  const idBase = useId();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [choices, setChoices] = useState<Map<string, GatherChoice>>(
    () => new Map()
  );
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reads = useRef(0);
  const retry = useRef<{ signature: string; key: string } | null>(null);
  const focused = useRef(false);

  async function read() {
    const ticket = ++reads.current;
    try {
      const list = await getPickList(deckId);
      if (ticket !== reads.current) return;
      const present = new Set(list.rows.map((row) => row.edition_id));
      setPicked(
        (current) => new Set([...current].filter((id) => present.has(id)))
      );
      setChoices((current) => {
        const kept = new Map<string, GatherChoice>();
        for (const row of list.rows) {
          const choice = current.get(row.edition_id);
          if (
            choice &&
            (choice === SUGGESTED
              ? offersSuggestion(row)
              : row.sources.some((source) => source.location_id === choice))
          )
            kept.set(row.edition_id, choice);
        }
        return kept;
      });
      setLoad({ kind: "ready", list });
    } catch {
      if (ticket !== reads.current) return;
      setLoad({ kind: "failed" });
    }
  }

  // Each opening reads the Pick List afresh and starts with only the copy sheet's card picked.
  useEffect(() => {
    if (!open) return;
    focused.current = false;
    retry.current = null;
    setError("");
    setChoices(new Map());
    setPicked(new Set(focusEdition ? [focusEdition] : []));
    setLoad({ kind: "loading" });
    void read();
  }, [open]);

  // Opened from the copy sheet: once the rows are drawn, that card's row takes focus.
  useLayoutEffect(() => {
    if (!open || !focusEdition || focused.current || load.kind !== "ready")
      return;
    focused.current = true;
    const box = document.getElementById(`${idBase}-pick-${focusEdition}`);
    box?.focus();
    box?.scrollIntoView({ block: "nearest" });
  }, [open, focusEdition, load]);

  const rows = load.kind === "ready" ? load.list.rows : [];
  const choiceOf = (row: PickRow) =>
    choices.get(row.edition_id) ?? defaultChoice(row);
  const allItems = confirmItems(rows, choices);
  const allCopies = allItems.reduce(
    (total, item) => total + BigInt(item.quantity),
    0n
  );
  const allSources = new Set(allItems.map((item) => item.source_id)).size;
  const pickedRows = rows.filter((row) => picked.has(row.edition_id));

  async function confirm(chosen: readonly PickRow[]) {
    if (busy || load.kind !== "ready") return;
    const items = confirmItems(chosen, choices);
    if (!items.length) return;
    const body = {
      items,
      deck_list_revision: load.list.deck_list_revision,
    };
    const signature = JSON.stringify(body);
    const key =
      retry.current?.signature === signature
        ? retry.current.key
        : crypto.randomUUID();
    retry.current = { signature, key };
    setBusy(true);
    setError("");
    try {
      const result = await confirmPicks(deckId, {
        ...body,
        idempotency_key: key,
      });
      retry.current = null;
      onConfirmed(result);
    } catch (cause) {
      if (!(cause instanceof DeckError) || cause.status >= 500) {
        // No answer: the copies may or may not have moved. The same key makes pressing again apply it once.
        setError(
          "Gathering may not have finished. Press the same button again to check safely."
        );
      } else {
        retry.current = null;
        setError(
          cause.code === "REPLAY_OUTCOME_UNAVAILABLE"
            ? "This may already have been gathered. The list is up to date again: check it before confirming."
            : CHANGED
        );
        void read();
        onChanged();
      }
    } finally {
      setBusy(false);
    }
  }

  const lineOf = (editionId: string) =>
    lines.find((line) => line.line.edition_id === editionId) ?? null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Gather cards you own"
      closeLabel="Close Gather"
      size="wide"
      returnFocus={returnFocus}
      bodyClassName="flex flex-col gap-3"
    >
      {load.kind === "loading" ? (
        <p role="status" className="m-0 text-body text-text-muted">
          Finding where your cards are…
        </p>
      ) : load.kind === "failed" ? (
        <>
          <p role="status" className="m-0 text-body text-text-muted">
            The Pick List couldn't be loaded. Check your connection and try
            again.
          </p>
          <Button className="self-start" onClick={() => void read()}>
            Retry
          </Button>
        </>
      ) : rows.length === 0 ? (
        <p className="m-0 text-body text-text-muted">
          Every copy you own for this Deck List is already in this Deck.
        </p>
      ) : (
        <>
          <p className="m-0 text-meta text-text-muted">
            {copiesText(allCopies)} from {locationsText(allSources)}. Loose
            storage comes first, from the fewest Locations; another Deck only
            when nothing else has the card.
          </p>
          <ul
            aria-label="Cards to gather"
            className="m-0 flex list-none flex-col p-0"
          >
            {rows.map((row) => {
              const line = lineOf(row.edition_id);
              const name = line?.line.name ?? "Card";
              const edition = line ? editionText(line) : "";
              const choice = choiceOf(row);
              const takes = takesFor(row, choice);
              const copies = rowCopies(takes);
              return (
                <li
                  key={row.edition_id}
                  className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 border-b border-border py-3 last:border-b-0"
                >
                  <label className="inline-flex size-control cursor-pointer items-center justify-center phone:size-tap">
                    <input
                      id={`${idBase}-pick-${row.edition_id}`}
                      type="checkbox"
                      className="m-0 size-4 accent-accent"
                      aria-label={`Pick ${name}${edition ? `, ${edition}` : ""}`}
                      checked={picked.has(row.edition_id)}
                      onChange={(event) => {
                        const on = event.currentTarget.checked;
                        setPicked((current) => {
                          const next = new Set(current);
                          if (on) next.add(row.edition_id);
                          else next.delete(row.edition_id);
                          return next;
                        });
                      }}
                    />
                  </label>
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="m-0 text-body font-medium wrap-anywhere">
                      {name}
                    </p>
                    {edition && (
                      <p className="m-0 text-meta text-text-muted wrap-anywhere">
                        {edition}
                      </p>
                    )}
                    <Select
                      label={`Source for ${name}`}
                      labelHidden
                      value={choice}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setChoices((current) =>
                          new Map(current).set(row.edition_id, value)
                        );
                      }}
                    >
                      {offersSuggestion(row) && (
                        <option value={SUGGESTED}>
                          {suggestionOption(row)}
                        </option>
                      )}
                      {row.sources.map((source) => (
                        <option
                          key={source.location_id}
                          value={source.location_id}
                        >
                          {sourceOption(source)}
                        </option>
                      ))}
                    </Select>
                    <p className="m-0 text-meta text-text-muted wrap-anywhere">
                      {copiesText(copies)}: {takesText(takes)}
                    </p>
                    {takes
                      .filter((take) => take.shortBy > 0n)
                      .map((take) => (
                        <p
                          key={take.source.location_id}
                          className="m-0 flex items-start gap-1 text-meta text-warning wrap-anywhere"
                        >
                          <Icon icon={TriangleAlert} />
                          Leaves {sourceLabel(take.source)}{" "}
                          {take.shortBy.toString()} short
                        </p>
                      ))}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {error && (
        <p role="alert" className="m-0 text-body text-warning">
          {error}
        </p>
      )}
      {rows.length > 0 && (
        <div className="sticky bottom-0 -mx-4 -mb-4 mt-auto flex flex-wrap items-center justify-end gap-2 border-t border-border bg-surface px-4 py-3">
          <Button
            disabled={pickedRows.length === 0}
            aria-disabled={busy || undefined}
            onClick={() => void confirm(pickedRows)}
          >
            {pickedRows.length
              ? `Confirm ${pickedRows.length} picked`
              : "Confirm picked"}
          </Button>
          <Button
            variant="primary"
            aria-disabled={busy || undefined}
            onClick={() => void confirm(rows)}
          >
            Confirm all
          </Button>
        </div>
      )}
    </Dialog>
  );
}
