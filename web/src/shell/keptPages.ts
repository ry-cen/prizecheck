import { PAGES, pageDef, type PageId } from "./routes";

/** Hidden slots always contain roots; detail screens exist only while shown. */
export function pageAddress(id: PageId, active: boolean, path: string): string {
  return active ? path : pageDef(id).path;
}

export function mountedPages(
  showing: PageId | null,
  visited: ReadonlySet<PageId>,
  warm: ReadonlySet<PageId>,
  owner: boolean
) {
  return PAGES.filter(
    ({ id }) =>
      (id !== "owner" || owner || showing === id) &&
      (id === showing || visited.has(id) || warm.has(id))
  );
}

/** null skips the read; false retries the initial failure normally; true refreshes quietly. */
export function activationRead(
  everShown: boolean,
  failed: boolean,
  skip: boolean
): boolean | null {
  if (skip || (!everShown && !failed)) return null;
  return everShown;
}
