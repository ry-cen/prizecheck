import { OWNER_SUBPATHS } from "../owner/sections";

/** The signed-in pages inside the app shell, and the addresses that open them. Routing is client-side. */
export type PageId =
  "collection" | "decks" | "catalog" | "reports" | "sign-ins" | "owner";

export type PageDef = {
  id: PageId;
  path: string;
  /** The tab, menu and phone header label; legacy pages also use it as their h1. */
  label: string;
  /** The page stays mounted, hidden, while another page is shown, so it keeps its state and scroll.
   * Old pages that read their data only on mount remount on every visit until their redesign ticket
   * moves them onto the kit and turns this on. */
  keepMounted: boolean;
  /** Sub-addresses under `path` that open this page on one of its sections, for example /owner/rules for
   * Owner controls' Rules tab. The page reads its section with sectionAt. */
  sections?: readonly string[];
  /** Any one further segment opens this page on that item, for example /decks/<Deck id> for a Deck in the deck
   * builder (#176). The page reads the item with sectionAt. */
  param?: boolean;
};

export const PAGES: readonly PageDef[] = [
  {
    id: "collection",
    path: "/collection",
    label: "Collection",
    keepMounted: true,
  },
  {
    id: "decks",
    path: "/decks",
    label: "Decks",
    keepMounted: false,
    param: true,
  },
  {
    id: "catalog",
    path: "/catalog",
    label: "Catalog",
    keepMounted: true,
  },
  {
    id: "reports",
    path: "/reports",
    label: "Missing cards",
    keepMounted: true,
  },
  {
    id: "sign-ins",
    path: "/settings/sign-ins",
    label: "Sign-ins",
    keepMounted: false,
  },
  {
    id: "owner",
    path: "/owner",
    label: "Owner controls",
    keepMounted: false,
    sections: OWNER_SUBPATHS,
  },
];

/** Desktop header tabs. */
export const DESKTOP_TABS: readonly PageId[] = [
  "collection",
  "decks",
  "catalog",
  "reports",
];
/** Phone bottom tab bar, before More. */
export const PHONE_TABS: readonly PageId[] = ["collection", "decks", "catalog"];
/** The phone More sheet's pages (Owner controls for the owner only), before Sign out. */
export const MORE_PAGES: readonly PageId[] = ["reports", "sign-ins", "owner"];
/** The desktop avatar menu's pages (Owner controls for the owner only), before Sign out. */
export const ACCOUNT_PAGES: readonly PageId[] = ["sign-ins", "owner"];

/** Where signing in lands by default. */
export const DEFAULT_PATH = "/collection";

/** Old addresses for Collection: the bare origin, the retired /workspace, /locations and /old-collection. Anything else
 * is returned unchanged. */
export function canonicalPath(path: string): string {
  return path === "/" ||
    path === "/workspace" ||
    path === "/locations" ||
    path === "/old-collection"
    ? DEFAULT_PATH
    : path;
}

export function pageAt(path: string): PageDef | undefined {
  return PAGES.find(
    (page) =>
      page.path === path ||
      (page.sections ?? []).some(
        (section) => path === `${page.path}/${section}`
      ) ||
      (page.param === true &&
        /^[^/]+$/.test(path.slice(page.path.length + 1)) &&
        path.startsWith(`${page.path}/`))
  );
}

/** The section a sub-address names (/owner/rules is "rules", /decks/<id> is the Deck id), or null for a page's
 * own address. */
export function sectionAt(path: string): string | null {
  const page = pageAt(path);
  return page && path !== page.path ? path.slice(page.path.length + 1) : null;
}

export function pageDef(id: PageId): PageDef {
  return PAGES.find((page) => page.id === id)!;
}
