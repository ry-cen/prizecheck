import type { CollectionHoldingView } from "../collection_generated";
import type { HoldingView } from "../holdings_generated";
import type { WorkspaceView } from "./LocationNav";

/** Card size choice. Ticket 104 persists it with the other display preferences. */
export type CardSize = "small" | "medium";

/** Display preferences: presentation only (size, names, and later prices). Sort, search and filters belong in `GalleryQuery`. */
export type DisplayPrefs = { size: CardSize; names: boolean };
export const DEFAULT_DISPLAY: DisplayPrefs = { size: "small", names: false };

/** What the gallery lists. Ticket 104 adds search text, filters and sort here; map each new field in `queryToParams` so it refetches. */
export type GalleryQuery = { view: WorkspaceView };

/** The listing request parameters for a query. The gallery refetches whenever this changes. */
export function queryToParams(query: GalleryQuery): { location_id?: string } {
  return query.view === "all" ? {} : { location_id: query.view };
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
  loadedCopies: 0,
  totals: null,
  ownerRevision: null,
  catalogRevision: null,
  status: "loading",
  error: null,
};

export const holdingKey = (locationId: string, editionId: string) =>
  `${locationId}:${editionId}`;

/** A tile's identity: Storage Leaf, Card Edition and ordinal within that Holding's quantity. */
export const tileKey = (
  locationId: string,
  editionId: string,
  ordinal: number
) => `${locationId}:${editionId}:${ordinal}`;

/** Appends one page of Holdings after `previous`, continuing the running tile index. */
export function appendHoldings(
  previous: GalleryHolding[],
  loadedCopies: number,
  rows: CollectionHoldingView[]
): { holdings: GalleryHolding[]; loadedCopies: number } {
  const holdings = previous.slice();
  let start = loadedCopies;
  for (const holding of rows) {
    const copies = Math.max(0, Number(holding.quantity) || 0);
    holdings.push({
      key: holdingKey(holding.location_id, holding.edition_id),
      holding,
      copies,
      start,
    });
    start += copies;
  }
  return { holdings, loadedCopies: start };
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
