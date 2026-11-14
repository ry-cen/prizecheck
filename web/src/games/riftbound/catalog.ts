/** Game-owned read seam. #661 can implement this without changing the view or using Pokémon clients. */
export type Domain = "Fury" | "Calm";
export type CardType = "Unit" | "Spell" | "Battlefield";
export type CatalogSet = { id: string; name: string; code: string };
export type Edition = {
  id: string;
  printingId: string;
  name: string;
  set: CatalogSet;
  number: string;
  domain: Domain | null;
  type: CardType;
  finish: string;
  art: string | null;
  orientation: "portrait" | "landscape";
};
export type Query = {
  search: string;
  set: string;
  domain: string;
  type: string;
  page: number;
};
export type Page = {
  editions: Edition[];
  total: number;
  pages: number;
  catalogEmpty: boolean;
};
export interface CatalogReader {
  readonly scope: "riftbound";
  sets(signal: AbortSignal): Promise<CatalogSet[]>;
  list(query: Query, signal: AbortSignal): Promise<Page>;
  detail(id: string, signal: AbortSignal): Promise<Edition | null>;
}
export const emptyQuery: Query = {
  search: "",
  set: "",
  domain: "",
  type: "",
  page: 1,
};
export function listKey(query: Query): string {
  return JSON.stringify([
    "riftbound",
    "catalog",
    query.search,
    query.set,
    query.domain,
    query.type,
    query.page,
  ]);
}
