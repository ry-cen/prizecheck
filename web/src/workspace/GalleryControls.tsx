import React, { useEffect, useRef } from "react";
import type { CollectionSet } from "../collection_generated";
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
import "./GalleryControls.css";

/** Matches MOBILE_QUERY in Workspace.tsx and the 760 px breakpoint in tokens.css. */
const MOBILE_QUERY = "(max-width: 760px)";
const FOCUSABLE =
  'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** The visible active-filter count. The control's accessible name carries it too ("Filters, 2 active"),
 * set through aria-label because the badge's box would otherwise add a space ("Filters , 2 active"). */
function ActiveCount({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span className="ws-filter-badge" aria-hidden="true">
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
    <button
      type="button"
      className="ws-filters-toggle"
      aria-expanded={open}
      aria-controls="ws-filter-panel"
      aria-label={activeName("Filters", filters)}
      onClick={onToggle}
    >
      Filters
      <ActiveCount count={activeFilterCount(filters)} />
    </button>
  );
}

/** Mobile header control that opens the Filters & display drawer. */
export const FiltersDrawerButton = React.forwardRef<
  HTMLButtonElement,
  { filters: GalleryFilters; open: boolean; onOpen: () => void }
>(function FiltersDrawerButton({ filters, open, onOpen }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className="ws-header-filters ws-mobile-only"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={activeName("Filters & display", filters)}
      onClick={onOpen}
    >
      Filters &amp; display
      <ActiveCount count={activeFilterCount(filters)} />
    </button>
  );
});

/** Set, Category and Elemental type, then Clear filters (which resets these three only). */
export function FilterControls({
  filters,
  sets,
  onChange,
}: {
  filters: GalleryFilters;
  /** The view's sets; a remembered set that isn't among them is still offered, by its id. */
  sets: readonly CollectionSet[];
  onChange: (next: GalleryFilters) => void;
}) {
  const setOptions =
    filters.set && !sets.some((set) => set.set_id === filters.set)
      ? [...sets, { set_id: filters.set, set_name: filters.set }]
      : sets;
  return (
    <div className="ws-filter-controls">
      <label className="ws-filter-field">
        <span>Set</span>
        <select
          aria-label="Set"
          value={filters.set}
          onChange={(event) =>
            onChange({ ...filters, set: event.target.value })
          }
        >
          <option value="">All</option>
          {setOptions.map((set) => (
            <option key={set.set_id} value={set.set_id}>
              {set.set_name}
            </option>
          ))}
        </select>
      </label>
      <label className="ws-filter-field">
        <span>Category</span>
        <select
          aria-label="Category"
          value={filters.category}
          onChange={(event) =>
            onChange({
              ...filters,
              category: event.target.value as GalleryFilters["category"],
            })
          }
        >
          <option value="">All</option>
          {CATEGORY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="ws-filter-field">
        <span>Elemental type</span>
        <select
          aria-label="Elemental type"
          value={filters.type}
          onChange={(event) =>
            onChange({
              ...filters,
              type: event.target.value as GalleryFilters["type"],
            })
          }
        >
          <option value="">All</option>
          {ELEMENTAL_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="ws-clear-filters"
        disabled={activeFilterCount(filters) === 0}
        onClick={() => onChange(NO_FILTERS)}
      >
        Clear filters
      </button>
    </div>
  );
}

export function SortControl({
  sort,
  onChange,
}: {
  sort: GallerySort;
  onChange: (next: GallerySort) => void;
}) {
  return (
    <label className="ws-display-field">
      <span>Sort</span>
      <select
        aria-label="Sort"
        value={sort}
        onChange={(event) => onChange(event.target.value as GallerySort)}
      >
        {SORT_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Card size and Names. */
export function DisplayControls({
  display,
  onChange,
}: {
  display: DisplayPrefs;
  onChange: (next: DisplayPrefs) => void;
}) {
  return (
    <>
      <label className="ws-display-field">
        <span>Card size</span>
        <select
          aria-label="Card size"
          value={display.size}
          onChange={(event) =>
            onChange({
              ...display,
              size: event.target.value === "medium" ? "medium" : "small",
            })
          }
        >
          <option value="small">Small</option>
          <option value="medium">Medium</option>
        </select>
      </label>
      <button
        type="button"
        aria-pressed={display.names}
        onClick={() => onChange({ ...display, names: !display.names })}
      >
        Names
      </button>
    </>
  );
}

/** The mobile Filters & display drawer: a modal dialog anchored right. Changes apply at once and
 * stay after it closes. Focus moves in, Tab stays inside, Escape and the backdrop close it, focus
 * returns to the opener, and widening the window past mobile closes it. */
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
  const drawerRef = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const returnTo = opener.current;
    const focusables = () =>
      Array.from(
        drawerRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []
      );
    focusables()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const inside = drawerRef.current?.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !inside)
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    const media = window.matchMedia(MOBILE_QUERY);
    const onMedia = () => {
      if (!media.matches) close.current();
    };
    document.addEventListener("keydown", onKeyDown);
    media.addEventListener("change", onMedia);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      media.removeEventListener("change", onMedia);
      document.body.style.overflow = overflow;
      if (returnTo?.isConnected && returnTo.getClientRects().length)
        returnTo.focus();
    };
  }, [opener]);

  return (
    <div className="ws-drawer-backdrop" onClick={() => close.current()}>
      <div
        ref={drawerRef}
        className="ws-drawer ws-filters-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ws-filters-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="ws-drawer-heading">
          <h2 id="ws-filters-title">Filters &amp; display</h2>
          <button
            type="button"
            className="ws-header-icon"
            aria-label="Close filters & display"
            onClick={() => close.current()}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        <FilterControls
          filters={prefs.filters}
          sets={sets}
          onChange={(filters) =>
            onChange((previous) => ({ ...previous, filters }))
          }
        />
        <div className="ws-drawer-display">
          <h3>Display</h3>
          <SortControl
            sort={prefs.sort}
            onChange={(sort) => onChange((previous) => ({ ...previous, sort }))}
          />
          <DisplayControls
            display={prefs.display}
            onChange={(display) =>
              onChange((previous) => ({ ...previous, display }))
            }
          />
        </div>
      </div>
    </div>
  );
}
