import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { editionWords, totalCopies, type AddQueue } from "./addQueue";
import { addAllLabel, QUEUE_HINT } from "./catalogText";
import type { Place } from "./usePlaces";

// The bar lists this many of the most recently queued cards (a phone two), then says how many more there are.
const SHOWN = 6;
const SHOWN_PHONE = 2;

type Props = {
  /** The Location the gallery was opened for (Collection's Add cards from a Location): shown, not chosen. */
  fixed: Place | null;
  /** The Locations the picker offers (Storage Leaves, by path), its choice, and whether they are still loading. */
  options: Place[];
  targetId: string | null;
  onTarget: (id: string) => void;
  optionsText: string;
  queue: AddQueue;
  /** False while there is no Location to add to yet (the picker still loading, or no Storage Leaf). */
  ready: boolean;
  busy: boolean;
  /** Why the last Add N cards added nothing, or "". */
  failure: string;
  /** A note under the queue, such as the 200-Edition limit, or "". */
  note: string;
  onClear: () => void;
  onAdd: () => void;
  /** "page": stuck under the shell's header (none on a phone); "dialog": stuck to the top of the dialog's body. */
  stick: "page" | "dialog";
};

/**
 * Add mode's one bar (#175, spec "Catalog": Add mode), stuck to the top while the gallery scrolls: Adding to
 * [Location], the queued cards, Clear and Add N cards. On a phone, Clear and Add appear once something is queued.
 */
export function AddBar({
  fixed,
  options,
  targetId,
  onTarget,
  optionsText,
  queue,
  ready,
  busy,
  failure,
  note,
  onClear,
  onAdd,
  stick,
}: Props) {
  const total = totalCopies(queue);
  const queued = Array.from(queue.values());
  const recent = queued.slice(-SHOWN);
  const hidden = queued.length - recent.length;
  const hiddenPhone = queued.length - Math.min(queued.length, SHOWN_PHONE);
  return (
    <section
      aria-label="Add to a Location"
      className={`sticky ${stick === "page" ? "top-(--layout-sticky-top)" : "top-0"} z-(--layer-sticky) box-border flex flex-col rounded-panel border border-accent-border bg-surface-raised px-3 py-2`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2 phone:w-full">
          <span className="text-meta font-semibold text-accent-strong">
            Adding to
          </span>{" "}
          {fixed ? (
            <strong className="min-w-0 text-body wrap-anywhere">
              {fixed.label}
            </strong>
          ) : (
            <div className="w-56 min-w-0 phone:flex-1">
              <Select
                label="Location to add to"
                labelHidden
                value={targetId ?? ""}
                disabled={!options.length}
                onChange={(event) => onTarget(event.target.value)}
              >
                {options.length ? (
                  options.map((place) => (
                    <option key={place.id} value={place.id}>
                      {place.label}
                    </option>
                  ))
                ) : (
                  <option value="">{optionsText}</option>
                )}
              </Select>
            </div>
          )}
        </div>
        {queued.length === 0 ? (
          <p className="m-0 min-w-0 flex-1 text-meta text-text-muted">
            {QUEUE_HINT}
          </p>
        ) : (
          <ul
            aria-label="Cards to add"
            className="m-0 flex min-w-0 flex-1 list-none flex-wrap items-center gap-1.5 p-0"
          >
            {recent.map((item, index) => (
              <li
                key={item.edition.edition_id}
                className={`box-border min-w-0 max-w-full truncate rounded-round border border-border-strong bg-surface px-2 py-0.5 text-meta tabular-nums${index < recent.length - SHOWN_PHONE ? " phone:hidden" : ""}`}
              >
                {item.count}× {editionWords(item.edition)}
              </li>
            ))}
            {hidden > 0 && (
              <li className="text-meta text-text-muted phone:hidden">
                and {hidden} more
              </li>
            )}
            {hiddenPhone > 0 && (
              <li className="hidden text-meta text-text-muted phone:list-item">
                and {hiddenPhone} more
              </li>
            )}
          </ul>
        )}
        <div
          className={`ml-auto flex shrink-0 items-center gap-2${total === 0 ? " phone:hidden" : ""}`}
        >
          <Button disabled={total === 0} onClick={onClear}>
            Clear
          </Button>
          <Button
            variant="primary"
            disabled={total === 0 || !ready}
            aria-disabled={busy || undefined}
            onClick={onAdd}
          >
            {addAllLabel(total)}
          </Button>
        </div>
      </div>
      {note && <p className="m-0 mt-1.5 text-meta text-text-muted">{note}</p>}
      {/* Always mounted, so a screen reader announces each failure. */}
      <p
        role="alert"
        className={`m-0 text-meta text-danger${failure ? " mt-1.5" : ""}`}
      >
        {failure}
      </p>
    </section>
  );
}
