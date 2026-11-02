import type { BorrowedMoveItem } from "../collection_generated";
import type { GalleryHolding, GalleryQuery, GridLayout } from "./galleryModel";

/** Selected ordinals of one Holding: sorted, disjoint, non-touching half-open runs [from, to).
 * A run covers any number of copies, so a selection never grows with the copies it holds. */
export type Runs = readonly (readonly [number, number])[];

/** One Holding's part of the selection. `count` is the selected quantity; `runs` only says which
 * of the Holding's tiles show as selected (copies are fungible, the server sees only `count`). */
export type SelectedHolding = {
  /** `${location_id}:${edition_id}`, as GalleryHolding.key. */
  key: string;
  loanId: string | null;
  locationId: string;
  editionId: string;
  /** The Holding's version when it was last added to; ticket 107 sends it as expected_version. */
  version: number;
  runs: Runs;
  count: number;
};

/** Holding key -> its selected part, in the order Holdings were first selected.
 * Holdings with nothing selected are never stored. */
export type Selection = ReadonlyMap<string, SelectedHolding>;
export const EMPTY_SELECTION: Selection = new Map();

/** One selected Holding as a multi-source manifest item (spec "Prototype-derived shapes").
 * Structurally the same as MoveItem in moves_generated.ts (ticket 106), so ticket 107 can stage it as is. */
export type SelectedGroup = {
  source_id: string;
  edition_id: string;
  /** Decimal string, as the manifest API expects. */
  quantity: string;
  expected_version: number;
};

export type SelectionSummary = {
  copies: number;
  editions: number;
  locations: number;
  borrowed: number;
};

/** Inclusive display-index spans, such as one per grid row of a marquee. */
export type IndexSpans = ReadonlyArray<readonly [number, number]>;

/** What decides whether the selection resets: the gallery query without its sort.
 * Changing search, filters or Location clears the selection; changing the sort keeps it.
 * Ticket 104 adds search and filter fields to GalleryQuery and must name its sort field `sort`. */
export function selectionScope(query: GalleryQuery): string {
  const { sort: _sort, ...listed } = query as GalleryQuery & {
    sort?: unknown;
  };
  return JSON.stringify(listed);
}

function runsHave(runs: Runs, ordinal: number): boolean {
  let low = 0;
  let high = runs.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [from, to] = runs[middle];
    if (ordinal < from) high = middle - 1;
    else if (ordinal >= to) low = middle + 1;
    else return true;
  }
  return false;
}

type MutableRuns = Array<[number, number]>;

function addRun(runs: MutableRuns, from: number, to: number) {
  if (from >= to) return;
  const last = runs[runs.length - 1];
  // Fast path: gestures add runs in increasing order.
  if (!last || from > last[1]) {
    runs.push([from, to]);
    return;
  }
  let first = 0;
  while (first < runs.length && runs[first][1] < from) first++;
  let end = first;
  let low = from;
  let high = to;
  while (end < runs.length && runs[end][0] <= to) {
    low = Math.min(low, runs[end][0]);
    high = Math.max(high, runs[end][1]);
    end++;
  }
  runs.splice(first, end - first, [low, high]);
}

function removeRun(runs: MutableRuns, from: number, to: number) {
  const kept: MutableRuns = [];
  for (const [a, b] of runs) {
    if (b <= from || a >= to) kept.push([a, b]);
    else {
      if (a < from) kept.push([a, from]);
      if (b > to) kept.push([to, b]);
    }
  }
  runs.length = 0;
  for (const run of kept) runs.push(run);
}

/** Copy-on-write builder: clones the map once, and each touched Holding's runs once. */
class Draft {
  private readonly next: Map<string, SelectedHolding>;
  private readonly touched = new Map<
    string,
    { holding: GalleryHolding; runs: MutableRuns }
  >();

  constructor(base: Selection) {
    this.next = new Map(base);
  }

  private runs(holding: GalleryHolding): MutableRuns {
    let entry = this.touched.get(holding.key);
    if (!entry) {
      const current = this.next.get(holding.key)?.runs ?? [];
      entry = {
        holding,
        runs: current.map(([a, b]) => [a, b] as [number, number]),
      };
      this.touched.set(holding.key, entry);
    }
    return entry.runs;
  }

  add(holding: GalleryHolding, from: number, to: number) {
    addRun(this.runs(holding), Math.max(0, from), Math.min(holding.copies, to));
  }

  remove(holding: GalleryHolding, from: number, to: number) {
    removeRun(this.runs(holding), from, to);
  }

  done(): Selection {
    for (const [key, { holding, runs }] of this.touched) {
      const count = runs.reduce((sum, [a, b]) => sum + (b - a), 0);
      if (count === 0) {
        this.next.delete(key);
        continue;
      }
      this.next.set(key, {
        key,
        loanId: holding.borrowed?.loanId ?? null,
        locationId: holding.holding.location_id,
        editionId: holding.holding.edition_id,
        version: holding.holding.version,
        runs,
        count,
      });
    }
    return this.next.size ? this.next : EMPTY_SELECTION;
  }
}

export function isTileSelected(
  selection: Selection,
  key: string,
  ordinal: number
): boolean {
  const entry = selection.get(key);
  return !!entry && runsHave(entry.runs, ordinal);
}

/** True when exactly one copy is selected and it is this tile. */
export function isOnlyTile(
  selection: Selection,
  key: string,
  ordinal: number
): boolean {
  if (selection.size !== 1) return false;
  const entry = selection.get(key);
  return !!entry && entry.count === 1 && runsHave(entry.runs, ordinal);
}

export function onlyTile(holding: GalleryHolding, ordinal: number): Selection {
  const draft = new Draft(EMPTY_SELECTION);
  draft.add(holding, ordinal, ordinal + 1);
  return draft.done();
}

export function toggleTile(
  selection: Selection,
  holding: GalleryHolding,
  ordinal: number
): Selection {
  const draft = new Draft(selection);
  if (isTileSelected(selection, holding.key, ordinal))
    draft.remove(holding, ordinal, ordinal + 1);
  else draft.add(holding, ordinal, ordinal + 1);
  return draft.done();
}

/** Index in `holdings` of the Holding that holds display index `index`, or -1. */
function holdingAt(holdings: GalleryHolding[], index: number): number {
  let low = 0;
  let high = holdings.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const candidate = holdings[middle];
    if (index < candidate.start) high = middle - 1;
    else if (index >= candidate.start + candidate.copies) low = middle + 1;
    else return middle;
  }
  return -1;
}

/** Adds every loaded tile in the spans. Indexes past the loaded tiles are ignored.
 * Work is per Holding touched, never per tile. */
export function addSpans(
  selection: Selection,
  holdings: GalleryHolding[],
  spans: IndexSpans
): Selection {
  if (!spans.length || !holdings.length) return selection;
  const lastHolding = holdings[holdings.length - 1];
  const loaded = lastHolding.start + lastHolding.copies;
  const draft = new Draft(selection);
  for (const [a, b] of spans) {
    const first = Math.max(0, Math.min(a, b));
    const last = Math.min(loaded - 1, Math.max(a, b));
    if (first > last) continue;
    let position = holdingAt(holdings, first);
    for (
      ;
      position >= 0 &&
      position < holdings.length &&
      holdings[position].start <= last;
      position++
    ) {
      const holding = holdings[position];
      if (!holding.copies) continue;
      draft.add(
        holding,
        first - holding.start,
        Math.min(holding.copies, last - holding.start + 1)
      );
    }
  }
  return draft.done();
}

/** Fits the selection to a complete listing: drops Holdings no longer listed, drops selected copies
 * past a Holding's current quantity, and takes each Holding's current version (the collector now sees
 * that state, so ticket 107 stages against it). Returns the same object when nothing changes. */
export function reconcileSelection(
  selection: Selection,
  byKey: ReadonlyMap<string, GalleryHolding>
): Selection {
  let next: Map<string, SelectedHolding> | null = null;
  for (const [key, entry] of selection) {
    const holding = byKey.get(key);
    const copies = holding?.copies ?? 0;
    const version = holding?.holding.version ?? entry.version;
    const last = entry.runs[entry.runs.length - 1];
    if (last && last[1] <= copies && version === entry.version) continue;
    next ??= new Map(selection);
    const runs = entry.runs
      .filter(([a]) => a < copies)
      .map(([a, b]) => [a, Math.min(b, copies)] as const);
    const count = runs.reduce((sum, [a, b]) => sum + (b - a), 0);
    if (count) next.set(key, { ...entry, version, runs, count });
    else next.delete(key);
  }
  if (!next) return selection;
  return next.size ? next : EMPTY_SELECTION;
}

export function summarizeSelection(selection: Selection): SelectionSummary {
  let copies = 0;
  let borrowed = 0;
  const editions = new Set<string>();
  const locations = new Set<string>();
  for (const entry of selection.values()) {
    copies += entry.count;
    if (entry.loanId) borrowed += entry.count;
    editions.add(entry.editionId);
    locations.add(entry.locationId);
  }
  return {
    copies,
    borrowed,
    editions: editions.size,
    locations: locations.size,
  };
}

/** The selection as manifest items, one per selected Holding (ticket 107 stages these). */
export function selectedGroups(selection: Selection): SelectedGroup[] {
  return Array.from(selection.values())
    .filter((entry) => !entry.loanId)
    .map((entry) => ({
      source_id: entry.locationId,
      edition_id: entry.editionId,
      quantity: String(entry.count),
      expected_version: entry.version,
    }));
}

/** A rectangle in grid coordinates (px from the grid's top-left corner). */
export type GridRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

/** The tiles a rectangle touches, as one inclusive display-index span per grid row.
 * Pure layout math, so it covers rows that aren't mounted. Gaps between tiles are misses. */
export function marqueeSpans(
  layout: GridLayout,
  rect: GridRect,
  tiles: number
): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  if (tiles <= 0 || layout.columns <= 0) return spans;
  const strideX = layout.tileWidth + layout.gapColumn;
  // Tile column c covers [c*strideX, c*strideX + tileWidth); row r covers [r*rowHeight, r*rowHeight + tileHeight).
  const firstColumn = Math.max(
    0,
    Math.floor((rect.left - layout.tileWidth) / strideX) + 1
  );
  const lastColumn = Math.min(
    layout.columns - 1,
    Math.ceil(rect.right / strideX) - 1
  );
  const rows = Math.ceil(tiles / layout.columns);
  const firstRow = Math.max(
    0,
    Math.floor((rect.top - layout.tileHeight) / layout.rowHeight) + 1
  );
  const lastRow = Math.min(
    rows - 1,
    Math.ceil(rect.bottom / layout.rowHeight) - 1
  );
  if (firstColumn > lastColumn) return spans;
  for (let row = firstRow; row <= lastRow; row++) {
    const first = row * layout.columns + firstColumn;
    const last = Math.min(tiles - 1, row * layout.columns + lastColumn);
    if (first <= last) spans.push([first, last]);
  }
  return spans;
}

export function selectedBorrowed(selection: Selection): BorrowedMoveItem[] {
  return Array.from(selection.values()).flatMap((entry) =>
    entry.loanId
      ? [
          {
            loan_id: entry.loanId,
            edition_id: entry.editionId,
            from_location_id: entry.locationId,
            quantity: String(entry.count),
          },
        ]
      : []
  );
}

/** Drop only Borrowed entries after their Move stage is confirmed. */
export function dropBorrowedSelection(selection: Selection): Selection {
  if (!Array.from(selection.values()).some((entry) => entry.loanId))
    return selection;
  return new Map(Array.from(selection).filter(([, entry]) => !entry.loanId));
}
