import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  getCatalogSets,
  type BrowseFormat,
  type BrowseKind,
  type CatalogSet,
} from "../catalog_browse_generated";
import { Chip, PickerChip } from "../ui/Chip";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../ui/Icon";
import { SearchField } from "../ui/SearchField";
import { FORMATS, KINDS } from "./catalogText";
import { eraKeyOf, groupSetsByEra, hasEras, type SetEra } from "./setEras";
import { ScrollArea } from "../ui/ScrollArea";

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
      <ScrollArea
        orientation="x"
        viewportRef={row}
        viewportClassName={`box-border flex min-w-0 items-center gap-1.5${more ? " mask-r-from-[calc(100%-var(--space-10))]" : ""}`}
        viewportProps={{ role: "group", "aria-label": "Filters" }}
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
      </ScrollArea>
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

/**
 * The set picker: every set in the catalog with a box that narrows the list. Sets sit in collapsible folders by era,
 * newest first (setEras.ts); all folders are closed on open except the one holding the chosen set, and typing in the
 * box opens every folder that still has a match. Until a catalog import has named the eras, the list is flat, A–Z.
 */
/** How long the set list stays fresh while the page lives. */
const SETS_STALE_MS = 5 * 60 * 1000;

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
  const fetchedAt = useRef(0);
  const reading = useRef(false);
  const hadSets = useRef(false);
  hadSets.current = sets !== null;
  const [filter, setFilter] = useState("");
  // The folders the collector flipped from their starting state (closed, or open while a filter is typed).
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setFilter("");
    setFlipped(new Set());
    // A list read a while ago is shown at once and read again behind it (#196): the catalog is refreshed from time to time.
    if (sets && Date.now() - fetchedAt.current < SETS_STALE_MS) return;
    if (reading.current) return;
    reading.current = true;
    setFailed(false);
    getCatalogSets()
      .then((list) => {
        fetchedAt.current = Date.now();
        setSets(list.sets);
      })
      .catch(() => {
        // A stale list stays usable when its refresh fails.
        if (!hadSets.current) setFailed(true);
      })
      // A read that finishes after the picker closed still keeps its list for the next opening.
      .finally(() => {
        reading.current = false;
      });
    // `sets` is read only to see whether a list is already shown; its own arrival must not run this again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const wanted = filter.trim().toLowerCase();
  const shown = (sets ?? []).filter(
    (entry) =>
      !wanted ||
      entry.set_name.toLowerCase().includes(wanted) ||
      entry.set_id.toLowerCase().startsWith(wanted) ||
      entry.set_code.toLowerCase().startsWith(wanted)
  );
  const eras = sets && hasEras(sets) ? groupSetsByEra(shown) : null;
  const startsOpen = (era: SetEra) =>
    wanted !== "" || era.key === eraKeyOf(current);
  const isOpen = (era: SetEra) => startsOpen(era) !== flipped.has(era.key);
  const flip = (key: string) =>
    setFlipped((before) => {
      const next = new Set(before);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const setRow = (entry: CatalogSet) => (
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
          onChange={(event) => {
            setFilter(event.target.value);
            setFlipped(new Set()); // folders start again from the new filter's state
          }}
          data-autofocus=""
        />
        {failed ? (
          <p role="alert" className="m-0 text-body text-danger">
            Sets are unavailable. Please retry.
          </p>
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
            {eras
              ? eras.map((era) => (
                  <li key={era.key}>
                    <button
                      type="button"
                      aria-expanded={isOpen(era)}
                      className={`${SET_ROW} font-semibold`}
                      onClick={() => flip(era.key)}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Icon
                          icon={isOpen(era) ? ChevronDown : ChevronRight}
                          size={16}
                        />
                        <span className="min-w-0 truncate">{era.name}</span>
                      </span>
                      <span className="shrink-0 text-meta font-normal text-text-subtle tabular-nums">
                        {era.sets.length.toLocaleString()}
                        <span className="sr-only">
                          {era.sets.length === 1 ? " set" : " sets"}
                        </span>
                      </span>
                    </button>
                    {isOpen(era) && (
                      <ul
                        aria-label={era.name}
                        className="m-0 mt-0.5 flex list-none flex-col gap-0.5 p-0 pl-4"
                      >
                        {era.sets.map(setRow)}
                      </ul>
                    )}
                  </li>
                ))
              : shown.map(setRow)}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
