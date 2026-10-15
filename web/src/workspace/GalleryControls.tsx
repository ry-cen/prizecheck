import React, { useEffect, useRef, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import type { CollectionSet } from "../collection_generated";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../ui/Icon";
import { Select, SelectBox } from "../ui/Select";
import {
  activeFilterCount,
  CATEGORY_OPTIONS,
  ELEMENTAL_TYPES,
  NO_FILTERS,
  SORT_OPTIONS,
  type DisplayPrefs,
  type GalleryFilters,
  type GallerySort,
} from "./galleryModel";
import type { GalleryPrefs } from "./galleryPrefs";
import { MOBILE_QUERY } from "./media";

/** A select with its label beside it, for the one-line desktop toolbar: the kit's control box (ui/control.ts)
 * at its own width. Every select here also carries aria-label: a name taken from a wrapping label would end
 * with the selected option ("Sort Name A–Z"), and the specs find each select by its exact name. */
const INLINE_FIELD =
  "inline-flex items-center gap-2 text-meta font-medium text-text-muted";
const INLINE_SELECT =
  "box-border m-0 h-control min-w-0 cursor-pointer appearance-none rounded-control border border-border-strong bg-bg pl-2 pr-7 font-sans text-control text-text phone:h-control-phone";

/** The visible active-filter count. The control's accessible name carries it too ("Filters, 2 active"),
 * set through aria-label because the badge's box would otherwise add a space ("Filters , 2 active"). */
function ActiveCount({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span
      className="box-border inline-block h-4.5 min-w-4.5 rounded-round bg-accent px-1 text-center text-micro leading-4.5 font-bold text-on-accent tabular-nums"
      aria-hidden="true"
    >
      {count}
    </span>
  );
}

/** "Filters" or "Filters, 2 active". */
const activeName = (name: string, filters: GalleryFilters) => {
  const count = activeFilterCount(filters);
  return count ? `${name}, ${count} active` : undefined;
};

/** Desktop toolbar button that shows and hides the filter panel. */
export function FiltersToggle({
  filters,
  open,
  onToggle,
}: {
  filters: GalleryFilters;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      aria-expanded={open}
      aria-controls="ws-filter-panel"
      aria-label={activeName("Filters", filters)}
      onClick={onToggle}
    >
      Filters
      <ActiveCount count={activeFilterCount(filters)} />
    </Button>
  );
}

/** Phone header control that opens the Filters & display drawer: an icon with the active-filter count, so the
 * header's search keeps its room on a 375 px screen. Its name says it in words. */
export const FiltersDrawerButton = React.forwardRef<
  HTMLButtonElement,
  { filters: GalleryFilters; open: boolean; onOpen: () => void }
>(function FiltersDrawerButton({ filters, open, onOpen }, ref) {
  return (
    <Button
      ref={ref}
      className="shrink-0"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={
        activeName("Filters & display", filters) ?? "Filters & display"
      }
      onClick={onOpen}
    >
      <Icon icon={SlidersHorizontal} />
      <ActiveCount count={activeFilterCount(filters)} />
    </Button>
  );
});

/** One filter: the kit Select with its label above it. */
function FilterSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="min-w-40">
      <Select
        label={label}
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </Select>
    </div>
  );
}

/** Set, Category and Elemental type, then Clear filters (which resets these three only). The options come
 * from galleryModel.ts; a new filter adds one FilterSelect here. `stacked` lays them out one under another,
 * full width (the phone drawer). */
export function FilterControls({
  filters,
  sets,
  onChange,
  stacked = false,
}: {
  filters: GalleryFilters;
  /** The view's sets; a remembered set that isn't among them is still offered, by its id. */
  sets: readonly CollectionSet[];
  onChange: (next: GalleryFilters) => void;
  stacked?: boolean;
}) {
  const setOptions =
    filters.set && !sets.some((set) => set.set_id === filters.set)
      ? [...sets, { set_id: filters.set, set_name: filters.set }]
      : sets;
  return (
    <div
      className={
        stacked ? "flex flex-col gap-3" : "flex flex-wrap items-end gap-3"
      }
    >
      <FilterSelect
        label="Set"
        value={filters.set}
        onChange={(set) => onChange({ ...filters, set })}
      >
        <option value="">All</option>
        {setOptions.map((set) => (
          <option key={set.set_id} value={set.set_id}>
            {set.set_name}
          </option>
        ))}
      </FilterSelect>
      <FilterSelect
        label="Category"
        value={filters.category}
        onChange={(category) =>
          onChange({
            ...filters,
            category: category as GalleryFilters["category"],
          })
        }
      >
        <option value="">All</option>
        {CATEGORY_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </FilterSelect>
      <FilterSelect
        label="Elemental type"
        value={filters.type}
        onChange={(type) =>
          onChange({ ...filters, type: type as GalleryFilters["type"] })
        }
      >
        <option value="">All</option>
        {ELEMENTAL_TYPES.map((type) => (
          <option key={type} value={type}>
            {type}
          </option>
        ))}
      </FilterSelect>
      <Button
        className={stacked ? "w-full" : undefined}
        disabled={activeFilterCount(filters) === 0}
        onClick={() => onChange(NO_FILTERS)}
      >
        Clear filters
      </Button>
    </div>
  );
}

export function SortControl({
  sort,
  onChange,
  stacked = false,
}: {
  sort: GallerySort;
  onChange: (next: GallerySort) => void;
  stacked?: boolean;
}) {
  const options = SORT_OPTIONS.map((option) => (
    <option key={option.value} value={option.value}>
      {option.label}
    </option>
  ));
  const change = (event: React.ChangeEvent<HTMLSelectElement>) =>
    onChange(event.target.value as GallerySort);
  if (stacked)
    return (
      <Select label="Sort" aria-label="Sort" value={sort} onChange={change}>
        {options}
      </Select>
    );
  return (
    <label className={INLINE_FIELD}>
      <span>Sort</span>
      <SelectBox
        className={INLINE_SELECT}
        aria-label="Sort"
        value={sort}
        onChange={change}
      >
        {options}
      </SelectBox>
    </label>
  );
}

/** Card size, Names and Prices (ticket 111). Names and Prices are toggle buttons (aria-pressed). */
export function DisplayControls({
  display,
  onChange,
  stacked = false,
}: {
  display: DisplayPrefs;
  onChange: (next: DisplayPrefs) => void;
  stacked?: boolean;
}) {
  const sizes = (
    <>
      <option value="small">Small</option>
      <option value="medium">Medium</option>
    </>
  );
  const changeSize = (event: React.ChangeEvent<HTMLSelectElement>) =>
    onChange({
      ...display,
      size: event.target.value === "medium" ? "medium" : "small",
    });
  return (
    <>
      {stacked ? (
        <Select
          label="Card size"
          aria-label="Card size"
          value={display.size}
          onChange={changeSize}
        >
          {sizes}
        </Select>
      ) : (
        <label className={INLINE_FIELD}>
          <span>Card size</span>
          <SelectBox
            className={INLINE_SELECT}
            aria-label="Card size"
            value={display.size}
            onChange={changeSize}
          >
            {sizes}
          </SelectBox>
        </label>
      )}
      <Button
        className={stacked ? "w-full" : undefined}
        aria-pressed={display.names}
        onClick={() => onChange({ ...display, names: !display.names })}
      >
        Names
      </Button>
      <Button
        className={stacked ? "w-full" : undefined}
        aria-pressed={display.prices}
        onClick={() => onChange({ ...display, prices: !display.prices })}
      >
        Prices
      </Button>
    </>
  );
}

/** The phone Filters & display drawer: the kit Dialog along the right edge. Changes apply at once and stay
 * after it closes. The kit moves focus in (its close button first), keeps Tab inside, closes on Escape and
 * the scrim, and returns focus to the opener; widening the window past a phone closes it. */
export function FiltersDrawer({
  opener,
  prefs,
  sets,
  onChange,
  onClose,
}: {
  opener: React.RefObject<HTMLButtonElement | null>;
  prefs: GalleryPrefs;
  sets: readonly CollectionSet[];
  onChange: (update: (previous: GalleryPrefs) => GalleryPrefs) => void;
  onClose: () => void;
}) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const media = window.matchMedia(MOBILE_QUERY);
    const onMedia = () => {
      if (!media.matches) close.current();
    };
    media.addEventListener("change", onMedia);
    return () => media.removeEventListener("change", onMedia);
  }, []);

  return (
    <Dialog
      open
      onClose={onClose}
      returnFocus={opener}
      title="Filters & display"
      closeLabel="Close filters & display"
      side="right"
    >
      <div className="flex flex-col gap-4">
        <FilterControls
          stacked
          filters={prefs.filters}
          sets={sets}
          onChange={(filters) =>
            onChange((previous) => ({ ...previous, filters }))
          }
        />
        <div className="flex flex-col gap-3 border-t border-border pt-4">
          <h3 className="m-0 text-micro font-semibold tracking-[1.7px] text-text-subtle uppercase">
            Display
          </h3>
          <SortControl
            stacked
            sort={prefs.sort}
            onChange={(sort) => onChange((previous) => ({ ...previous, sort }))}
          />
          <DisplayControls
            stacked
            display={prefs.display}
            onChange={(display) =>
              onChange((previous) => ({ ...previous, display }))
            }
          />
        </div>
      </div>
    </Dialog>
  );
}
