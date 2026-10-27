import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  getCatalogSets,
  type BrowseFormat,
  type BrowseKind,
  type CatalogSet,
} from "../catalog_browse_generated";
import { Button } from "../ui/Button";
import { Chip, PickerChip } from "../ui/Chip";
import { Dialog } from "../ui/Dialog";
import { SearchField } from "../ui/SearchField";
import { FORMATS, KINDS } from "./catalogText";

type Props = {
  format: BrowseFormat | null;
  onFormat: (format: BrowseFormat | null) => void;
  kind: BrowseKind | null;
  onKind: (kind: BrowseKind | null) => void;
  set: CatalogSet | null;
  onSet: (set: CatalogSet | null) => void;
  owned: boolean;
  onOwned: (owned: boolean) => void;
};

/**
 * Catalog's one filter row (spec "Catalog": filters), under the search box: the format chips (Any, Standard,
 * Expanded, GLC) and the type chips, then the set picker styled as a chip and the Owned only chip. The row scrolls
 * sideways inside itself, never the page, and fades at its right edge while more chips are hidden there.
 */
export function CatalogFilters({
  format,
  onFormat,
  kind,
  onKind,
  set,
  onSet,
  owned,
  onOwned,
}: Props) {
  const row = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const [picking, setPicking] = useState(false);
  const picker = useRef<HTMLButtonElement>(null);

  // Fade the edge only while chips are hidden past it.
  useLayoutEffect(() => {
    const element = row.current;
    if (!element) return;
    const measure = () =>
      setMore(
        element.scrollLeft + element.clientWidth < element.scrollWidth - 1
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", measure);
    };
  }, [set]);

  return (
    <>
      <div
        ref={row}
        role="group"
        aria-label="Filters"
        className={`box-border flex min-w-0 items-center gap-1.5 overflow-x-auto${more ? " mask-r-from-[calc(100%-var(--space-10))]" : ""}`}
      >
        <Chip selected={format === null} onChange={() => onFormat(null)}>
          Any format
        </Chip>
        {FORMATS.map((option) => (
          <Chip
            key={option.value}
            selected={format === option.value}
            onChange={(on) => onFormat(on ? option.value : null)}
          >
            {option.label}
          </Chip>
        ))}
        <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
        {KINDS.map((option) => (
          <Chip
            key={option.value}
            selected={kind === option.value}
            onChange={(on) => onKind(on ? option.value : null)}
          >
            {option.label}
          </Chip>
        ))}
        <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
        <PickerChip
          active={set !== null}
          buttonRef={picker}
          onClick={() => setPicking(true)}
        >
          {set ? `Set: ${set.set_name}` : "Any set"}
        </PickerChip>
        <Chip selected={owned} onChange={onOwned}>
          Owned only
        </Chip>
      </div>
      <SetPicker
        open={picking}
        current={set}
        returnFocus={picker}
        onClose={() => setPicking(false)}
        onPick={(next) => {
          setPicking(false);
          onSet(next);
        }}
      />
    </>
  );
}

const SET_ROW =
  "box-border m-0 flex min-h-control w-full cursor-pointer items-center justify-between gap-3 rounded-control border border-transparent bg-transparent px-2 py-1 text-left font-sans text-control text-text hover:bg-surface-raised aria-pressed:border-accent-border aria-pressed:bg-surface-selected aria-pressed:text-accent-strong phone:min-h-tap";

/** The set picker: every set in the catalog, A–Z by name, with a box that narrows the list. */
function SetPicker({
  open,
  current,
  returnFocus,
  onClose,
  onPick,
}: {
  open: boolean;
  current: CatalogSet | null;
  returnFocus: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onPick: (set: CatalogSet | null) => void;
}) {
  const [sets, setSets] = useState<CatalogSet[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (!open) return;
    if (sets) return;
    setFailed(false);
    let cancelled = false;
    getCatalogSets()
      .then((list) => {
        if (!cancelled) setSets(list.sets);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, sets, attempt]);
  useEffect(() => {
    if (open) setFilter("");
  }, [open]);

  const wanted = filter.trim().toLowerCase();
  const shown = (sets ?? []).filter(
    (entry) =>
      !wanted ||
      entry.set_name.toLowerCase().includes(wanted) ||
      entry.set_id.toLowerCase().startsWith(wanted) ||
      entry.set_code.toLowerCase().startsWith(wanted)
  );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Choose a set"
      closeLabel="Close set picker"
      returnFocus={returnFocus}
    >
      <div className="flex flex-col gap-3">
        <SearchField
          label="Filter sets"
          placeholder="Set name or code"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          data-autofocus=""
        />
        {failed ? (
          <div className="flex flex-wrap items-center gap-3">
            <p role="alert" className="m-0 text-body text-danger">
              Sets couldn't be loaded.
            </p>
            <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
          </div>
        ) : !sets ? (
          <p role="status" className="m-0 text-body text-text-muted">
            Loading sets…
          </p>
        ) : (
          <ul
            aria-label="Sets"
            className="m-0 flex list-none flex-col gap-0.5 p-0"
          >
            <li>
              <button
                type="button"
                aria-pressed={current === null}
                className={SET_ROW}
                onClick={() => onPick(null)}
              >
                Any set
              </button>
            </li>
            {shown.map((entry) => (
              <li key={entry.set_id}>
                <button
                  type="button"
                  aria-pressed={current?.set_id === entry.set_id}
                  className={SET_ROW}
                  onClick={() => onPick(entry)}
                >
                  <span className="min-w-0 truncate">{entry.set_name}</span>
                  <span className="shrink-0 text-meta text-text-subtle tabular-nums">
                    {entry.set_code} · {entry.printings.toLocaleString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
