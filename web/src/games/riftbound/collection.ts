import type { TreeNode } from "../../location_generated";
import type { Edition } from "./catalog";
/** Fixture numbers are safe positive integers; the HTTP core represents quantities as decimal strings. */
export type HoldingRow = {
  edition: Edition;
  locationId: string;
  quantity: number;
  version: number;
};
export type CollectionQuery = {
  location: string;
  search: string;
  page: number;
};
export type CollectionPage = {
  rows: (HoldingRow & { copies: { first: number; count: number } })[];
  totals: { copies: number; editions: number };
  pages: number;
  collectionEmpty: boolean;
};
export interface CollectionReader {
  readonly scope: "riftbound";
  readonly owner: string;
  locations(signal: AbortSignal): Promise<TreeNode[]>;
  list(query: CollectionQuery, signal: AbortSignal): Promise<CollectionPage>;
  holdings(editionId: string, signal: AbortSignal): Promise<HoldingRow[]>;
}
export const emptyCollectionQuery: CollectionQuery = {
  location: "all",
  search: "",
  page: 1,
};
export function collectionKey(owner: string, query: CollectionQuery): string {
  return JSON.stringify([
    "riftbound",
    "collection",
    owner,
    query.location,
    query.search,
    query.page,
  ]);
}
/** Expansion stays game-local: shared galleryModel also carries Pokémon runtime labels. */
export function expandCopies(
  rows: (HoldingRow & { copies?: { first: number; count: number } })[]
) {
  return rows.flatMap((row) =>
    Array.from({ length: row.copies?.count ?? row.quantity }, (_, copy) => ({
      ...row,
      copy: copy + (row.copies?.first ?? 0),
      key: JSON.stringify([
        row.locationId,
        row.edition.id,
        copy + (row.copies?.first ?? 0),
      ]),
    }))
  );
}

/** Fixture-only tile paging; core HTTP readers page Holdings instead. */
export function pageHoldings(
  rows: HoldingRow[],
  pageNumber: number
): CollectionPage["rows"] {
  const page = new Map<string, CollectionPage["rows"][number]>();
  for (const copy of expandCopies(rows).slice(
    (pageNumber - 1) * 24,
    pageNumber * 24
  )) {
    const key = JSON.stringify([copy.locationId, copy.edition.id]);
    const previous = page.get(key);
    if (previous) previous.copies.count++;
    else
      page.set(key, {
        edition: copy.edition,
        locationId: copy.locationId,
        version: copy.version,
        quantity: copy.quantity,
        copies: { first: copy.copy, count: 1 },
      });
  }
  return [...page.values()];
}
