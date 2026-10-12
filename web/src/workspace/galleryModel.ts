import type {
  CardCategory,
  CollectionHoldingQuery,
  CollectionHoldingView,
  ElementalType,
  HoldingSort,
} from "../collection_generated";
import type { HoldingView } from "../holdings_generated";
import type { WorkspaceView } from "./LocationNav";

/** Card size choice, remembered with the other preferences (galleryPrefs.ts). */
export type CardSize = "small" | "medium";

/** Display preferences: presentation only (size, names and prices). Sort, search and filters belong in `GalleryQuery`.
 * `prices` shows each mounted tile's Card Edition price under it (ticket 111); it is off by default. */
export type DisplayPrefs = { size: CardSize; names: boolean; prices: boolean };
export const DEFAULT_DISPLAY: DisplayPrefs = {
  size: "small",
  names: false,
  prices: false,
};

/** Sort choice: a key and a direction, sent to the listing as is. Name A–Z is the default. */
export type GallerySort = HoldingSort;
export const DEFAULT_SORT: GallerySort = "name-asc";
export const SORT_OPTIONS: readonly { value: GallerySort; label: string }[] = [
  { value: "name-asc", label: "Name A–Z" },
  { value: "name-desc", label: "Name Z–A" },
  { value: "set-asc", label: "Set / number ↑" },
  { value: "set-desc", label: "Set / number ↓" },
  { value: "quantity-desc", label: "Quantity ↓" },
  { value: "quantity-asc", label: "Quantity ↑" },
];

export const CATEGORY_OPTIONS: readonly {
  value: CardCategory;
  label: string;
}[] = [
  { value: "Pokemon", label: "Pokémon" },
  { value: "Trainer", label: "Trainer" },
  { value: "Energy", label: "Energy" },
];

/** The game's elemental types, in the order the game lists them. */
export const ELEMENTAL_TYPES: readonly ElementalType[] = [
  "Grass",
  "Fire",
  "Water",
  "Lightning",
  "Psychic",
  "Fighting",
  "Darkness",
  "Metal",
  "Fairy",
  "Dragon",
  "Colorless",
];

/** Filter values; "" means any. Each filter narrows independently of the others. */
export type GalleryFilters = {
  set: string;
  category: CardCategory | "";
  type: ElementalType | "";
};
export const NO_FILTERS: GalleryFilters = { set: "", category: "", type: "" };

/** How many filters are narrowing the gallery. */
export const activeFilterCount = (filters: GalleryFilters) =>
  [filters.set, filters.category, filters.type].filter(Boolean).length;

/** What the gallery lists. Map every field in `queryToParams`, so a change refetches. */
export type GalleryQuery = {
  view: WorkspaceView;
  /** Card name search text, as typed (already debounced). */
  search: string;
  filters: GalleryFilters;
  sort: GallerySort;
};

/** The listing request parameters for a query, in a fixed field order. The gallery refetches whenever this changes. */
export function queryToParams(query: GalleryQuery): CollectionHoldingQuery {
  const params: CollectionHoldingQuery = {};
  if (query.view !== "all") params.location_id = query.view;
  params.sort = query.sort;
  const search = query.search.trim();
  if (search) params.name = search;
  if (query.filters.set) params.set_id = query.filters.set;
  if (query.filters.category) params.category = query.filters.category;
  if (query.filters.type) params.elemental_type = query.filters.type;
  return params;
}

/** One Holding in display order. A tile is (Holding, ordinal); no per-copy records exist anywhere. */
export type GalleryHolding = {
  /** `${location_id}:${edition_id}`. Ticket 105 keys selected counts by this. */
  key: string;
  holding: CollectionHoldingView;
  /** The Holding's quantity: one tile per copy. */
  copies: number;
  /** Display index of this Holding's first tile (running sum of earlier copies). */
  start: number;
};

export type GalleryTotals = {
  holdings: number;
  editions: number;
  copies: number;
};

/** loading: no page yet. partial: some pages shown, more loading or a later page failed. */
export type GalleryStatus = "loading" | "partial" | "ready" | "error";

export type GalleryData = {
  holdings: GalleryHolding[];
  /** The loaded Holdings by key. One Map per walk, extended in place as pages arrive, so a page costs only its
   * own rows; its identity changes only when a new walk (a query change or a reload) starts. Read it, never write it. */
  byKey: ReadonlyMap<string, GalleryHolding>;
  /** Tiles covered by the loaded Holdings. Indexes at or past this render placeholders. */
  loadedCopies: number;
  /** From the first page; null until it arrives. */
  totals: GalleryTotals | null;
  ownerRevision: number | null;
  catalogRevision: number | null;
  status: GalleryStatus;
  /** Inline error text, or null. */
  error: string | null;
};

export const EMPTY_GALLERY: GalleryData = {
  holdings: [],
  byKey: new Map(),
  loadedCopies: 0,
  totals: null,
  ownerRevision: null,
  catalogRevision: null,
  status: "loading",
  error: null,
};

/** Two complete listings show the same thing: equal revisions and totals, and the same Holdings in the same
 * order with the same fields. Equal revisions alone don't prove it: a metadata review changes a Printing's
 * category or types without moving the catalog revision. */
export function sameListing(a: GalleryData, b: GalleryData): boolean {
  if (
    a.ownerRevision !== b.ownerRevision ||
    a.catalogRevision !== b.catalogRevision ||
    a.totals?.holdings !== b.totals?.holdings ||
    a.totals?.editions !== b.totals?.editions ||
    a.totals?.copies !== b.totals?.copies ||
    a.holdings.length !== b.holdings.length
  )
    return false;
  return a.holdings.every(
    (entry, index) =>
      JSON.stringify(entry.holding) ===
      JSON.stringify(b.holdings[index].holding)
  );
}

export const holdingKey = (locationId: string, editionId: string) =>
  `${locationId}:${editionId}`;

/** A tile's identity: Storage Leaf, Card Edition and ordinal within that Holding's quantity. */
export const tileKey = (
  locationId: string,
  editionId: string,
  ordinal: number
) => `${locationId}:${editionId}:${ordinal}`;

/** Appends one page of Holdings after `previous`, continuing the running tile index. Only the page's rows are
 * processed (earlier entries are copied by reference); `byKey`, when given, gains each new entry. */
export function appendHoldings(
  previous: GalleryHolding[],
  loadedCopies: number,
  rows: CollectionHoldingView[],
  byKey?: Map<string, GalleryHolding>
): { holdings: GalleryHolding[]; loadedCopies: number } {
  const holdings = previous.slice();
  let start = loadedCopies;
  for (const holding of rows) {
    const copies = Math.max(0, Number(holding.quantity) || 0);
    const entry: GalleryHolding = {
      key: holdingKey(holding.location_id, holding.edition_id),
      holding,
      copies,
      start,
    };
    holdings.push(entry);
    byKey?.set(entry.key, entry);
    start += copies;
  }
  return { holdings, loadedCopies: start };
}

/** How many leading entries of `next` were already in `previous`: all of them when `next` is `previous` plus
 * later pages of the same walk (appendHoldings keeps each earlier entry object), otherwise 0. Per-page work
 * then touches only the new rows. */
export function appendedFrom(
  previous: readonly GalleryHolding[],
  next: readonly GalleryHolding[]
): number {
  const count = previous.length;
  return count > 0 &&
    next.length >= count &&
    next[0] === previous[0] &&
    next[count - 1] === previous[count - 1]
    ? count
    : 0;
}

export type TileRef = {
  holding: GalleryHolding;
  /** 0-based ordinal within the Holding; the label shows ordinal + 1. */
  ordinal: number;
  /** Display index. */
  index: number;
};

/** The tile at a display index, or null past the loaded tiles. Binary search over Holdings. */
export function tileAt(
  holdings: GalleryHolding[],
  index: number
): TileRef | null {
  let low = 0;
  let high = holdings.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const candidate = holdings[middle];
    if (index < candidate.start) high = middle - 1;
    else if (index >= candidate.start + candidate.copies) low = middle + 1;
    else return { holding: candidate, ordinal: index - candidate.start, index };
  }
  return null;
}

/** Card art height divided by width; matches --tile-aspect (245 / 342) in tokens.css. */
export const ART_RATIO = 342 / 245;

/** Tile sizes and gaps, read from the CSS variables in tokens.css (they change on mobile). */
export type TileMetrics = {
  small: number;
  medium: number;
  gapRow: number;
  gapColumn: number;
  namesHeight: number;
  captionHeight: number;
  priceHeight: number;
};

export function readTileMetrics(element: Element): TileMetrics {
  const style = getComputedStyle(element);
  const px = (name: string, fallback: number) => {
    const value = parseFloat(style.getPropertyValue(name));
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    small: px("--tile-small", 110),
    medium: px("--tile-medium", 145),
    gapRow: px("--tile-gap-row", 20),
    gapColumn: px("--tile-gap-column", 12),
    namesHeight: px("--tile-names-height", 34),
    captionHeight: px("--tile-caption-height", 18),
    priceHeight: px("--tile-price-height", 18),
  };
}

/** The gallery's layout model. Ticket 105 hit-tests Shift-range and marquee against it, not the DOM. */
export type GridLayout = {
  columns: number;
  tileWidth: number;
  artHeight: number;
  tileHeight: number;
  /** Tile height plus the row gap. */
  rowHeight: number;
  gapColumn: number;
  rows: number;
  /** Total grid height in px for `tiles` tiles. */
  height: number;
};

/** Cards per row follow the width: as many minimum-size tiles as fit, then stretched to fill the row. */
export function computeLayout(
  width: number,
  tiles: number,
  display: DisplayPrefs,
  caption: boolean,
  metrics: TileMetrics
): GridLayout {
  const minimum = display.size === "medium" ? metrics.medium : metrics.small;
  const gap = metrics.gapColumn;
  const columns = Math.max(1, Math.floor((width + gap) / (minimum + gap)));
  const tileWidth = Math.max(minimum, (width - gap * (columns - 1)) / columns);
  const artHeight = tileWidth * ART_RATIO;
  const tileHeight =
    artHeight +
    (display.names ? metrics.namesHeight : 0) +
    (display.prices ? metrics.priceHeight : 0) +
    (caption ? metrics.captionHeight : 0);
  const rowHeight = tileHeight + metrics.gapRow;
  const rows = Math.ceil(tiles / columns);
  return {
    columns,
    tileWidth,
    artHeight,
    tileHeight,
    rowHeight,
    gapColumn: gap,
    rows,
    height: rows ? rows * rowHeight - metrics.gapRow : 0,
  };
}

/** A tile's box relative to the grid's top-left corner. */
export function tileRect(layout: GridLayout, index: number) {
  const column = index % layout.columns;
  const row = Math.floor(index / layout.columns);
  return {
    x: column * (layout.tileWidth + layout.gapColumn),
    y: row * layout.rowHeight,
    width: layout.tileWidth,
    height: layout.tileHeight,
  };
}

const counts = new Intl.NumberFormat("en-US");

/** "1 copy", "2 copies", "25,000 copies". */
export const plural = (n: number, one: string, many: string) =>
  `${counts.format(n)} ${n === 1 ? one : many}`;

/** "Pikachu, Base Set 25, copy 2, Shelf / Binder 2" */
export const tileLabel = (
  holding: HoldingView,
  ordinal: number,
  path: string
) =>
  `${holding.printing_name}, ${holding.set_name} ${holding.collector_number}, copy ${ordinal + 1}, ${path}`;

/** "Pikachu · Base Set 25 · copy 2 · Shelf / Binder 2" */
export const tileTitle = (
  holding: HoldingView,
  ordinal: number,
  path: string
) =>
  `${holding.printing_name} · ${holding.set_name} ${holding.collector_number} · copy ${ordinal + 1} · ${path}`;
